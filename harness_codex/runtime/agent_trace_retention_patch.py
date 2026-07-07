"""Keep raw agent logs for failures while compacting successful traces."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.models import StepStatus


SUCCESS_STDERR_TAIL_BYTES = 16_384


def apply_agent_trace_retention_patch() -> None:
    """Replace successful raw log retention with compact trace metadata.

    The adapter writes files while the provider runs, so timeout and process
    failures retain their complete diagnostic streams. This hook runs only after a
    successful result has produced its final message and any executor checkpoint.
    """

    import harness_codex.runtime.runner as runner

    original_mirror = runner._mirror_agent_artifacts
    if getattr(original_mirror, "_agent_trace_retention_patch", False):
        return

    def mirror_agent_artifacts(request, stdout_path, stderr_path, final_message_path, result):
        if result.status is not StepStatus.SUCCEEDED or _retains_full_trace(request):
            original_mirror(request, stdout_path, stderr_path, final_message_path, result)
            return

        summary = _success_trace_summary(stdout_path, stderr_path, final_message_path)
        _compact_checkpoint(request.step_dir / "checkpoint.json")
        _annotate_result_metadata(result, summary)
        _write_success_response(runner, request, final_message_path, result, summary)
        _remove_raw_logs(stdout_path, stderr_path)
        runner._write_usage_snapshot(request, result)

    mirror_agent_artifacts._agent_trace_retention_patch = True
    runner._mirror_agent_artifacts = mirror_agent_artifacts


def _retains_full_trace(request) -> bool:
    value = request.step.metadata.get("agent_trace_retention", "summary")
    return str(value).strip().lower() == "full"


def _success_trace_summary(
    stdout_path: Path,
    stderr_path: Path,
    final_message_path: Path | None,
) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "retention": "summary",
        "stdout": _artifact_summary(stdout_path),
        "stderr": _artifact_summary(stderr_path, include_tail=True),
    }
    usage = _provider_usage(stdout_path)
    if usage:
        summary["usage"] = usage
    if final_message_path is not None:
        summary["final_message"] = _artifact_summary(final_message_path)
    return summary


def _provider_usage(stdout_path: Path) -> dict[str, int | None]:
    """Extract only provider accounting fields before removing a JSONL stream."""

    try:
        stdout = stdout_path.read_text(encoding="utf-8")
    except OSError:
        return {}
    from harness_codex.runtime.token_observability import extract_codex_usage

    extracted = extract_codex_usage(stdout)
    if not extracted["found"]:
        return {}
    usage = extracted["usage"]
    return {
        "input_tokens": usage.get("input_tokens"),
        "prompt_tokens": usage.get("input_tokens"),
        "cached_input_tokens": usage.get("cached_input_tokens"),
        "cached_prompt_tokens": usage.get("cached_input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "completion_tokens": usage.get("output_tokens"),
        "reasoning_tokens": usage.get("reasoning_tokens"),
        "total_tokens": usage.get("total_tokens"),
    }


def _artifact_summary(path: Path, *, include_tail: bool = False) -> dict[str, Any]:
    try:
        size_bytes = path.stat().st_size
    except OSError:
        return {"present": False, "bytes": 0}

    summary: dict[str, Any] = {"present": True, "bytes": size_bytes}
    if include_tail and size_bytes:
        try:
            with path.open("rb") as stream:
                stream.seek(max(0, size_bytes - SUCCESS_STDERR_TAIL_BYTES), os.SEEK_SET)
                payload = stream.read(SUCCESS_STDERR_TAIL_BYTES)
                tail = payload.decode("utf-8", errors="replace").strip()
        except OSError:
            tail = ""
        if tail:
            summary["tail"] = tail
    return summary


def _compact_checkpoint(path: Path) -> None:
    """Remove raw stdout evidence after its resume facts were extracted."""

    if not path.is_file():
        return
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return
    if not isinstance(payload, dict):
        return
    evidence_paths = payload.get("evidence_paths")
    if isinstance(evidence_paths, list):
        payload["evidence_paths"] = [
            item
            for item in evidence_paths
            if not str(item).replace("\\", "/").endswith("/stdout.txt")
        ]
    payload["trace_retention"] = "summary"
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _annotate_result_metadata(result, summary: Mapping[str, Any]) -> None:
    if not isinstance(result.metadata, dict):
        return
    result.metadata.pop("stdout_path", None)
    result.metadata.pop("stderr_path", None)
    result.metadata["trace_retention"] = "summary"
    result.metadata["trace_summary"] = dict(summary)
    usage = summary.get("usage")
    if isinstance(usage, Mapping):
        result.metadata["usage"] = dict(usage)


def _write_success_response(
    runner,
    request,
    final_message_path,
    result,
    summary: Mapping[str, Any],
) -> None:
    request.context.run_dir.mkdir(parents=True, exist_ok=True)
    response = {
        "step_id": request.step.id,
        "status": result.status.value,
        "exit_code": result.exit_code,
        "error": result.error,
        "metadata": dict(result.metadata),
        "trace": dict(summary),
    }
    if final_message_path is not None and final_message_path.exists():
        response["final_message_path"] = str(
            runner._relative_to_repo(final_message_path, request.context)
        )
    response_path = request.context.run_dir / f"response-{request.step.id}.json"
    response_path.write_text(
        json.dumps(response, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _remove_raw_logs(stdout_path: Path, stderr_path: Path) -> None:
    for path in (stdout_path, stderr_path):
        try:
            path.unlink()
        except FileNotFoundError:
            continue
