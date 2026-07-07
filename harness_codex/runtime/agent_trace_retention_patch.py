"""Compact successful agent traces only after the runtime accepts the artifact contract."""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import replace
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.models import StepStatus

SUCCESS_STDERR_TAIL_BYTES = 16_384
TRACE_SUMMARY_SCHEMA_VERSION = 1


def apply_agent_trace_retention_patch() -> None:
    """Move trace cleanup after deterministic runtime contract checks."""

    import harness_codex.runtime.runner as runner

    original_run_agent = runner.BasicStepRunner._run_agent
    if getattr(original_run_agent, "_agent_trace_retention_patch", False):
        return

    def run_agent(self, step, context, step_dir):
        result = original_run_agent(self, step, context, step_dir)
        if result.status is not StepStatus.SUCCEEDED or _retains_full_trace(step):
            return result

        metadata = _compact_accepted_agent_trace(
            runner=runner,
            step=step,
            context=context,
            step_dir=step_dir,
            result=result,
        )
        if metadata is None:
            return result
        return replace(result, metadata={**dict(result.metadata), **metadata})

    run_agent._agent_trace_retention_patch = True
    runner.BasicStepRunner._run_agent = run_agent


def _retains_full_trace(step) -> bool:
    value = step.metadata.get("agent_trace_retention", "summary")
    return str(value).strip().lower() == "full"


def _compact_accepted_agent_trace(*, runner, step, context, step_dir: Path, result):
    result_path = step_dir / "result.json"
    final_message_path = step_dir / "final-message.md"
    stdout_path = step_dir / "stdout.txt"
    stderr_path = step_dir / "stderr.txt"

    contract = _accepted_contract(step, context, result_path, final_message_path, result)
    if contract is None:
        return None

    summary = {
        "schema_version": TRACE_SUMMARY_SCHEMA_VERSION,
        "retention": "summary",
        "contract": contract,
        "streams": {
            "stdout": _artifact_summary(stdout_path),
            "stderr": _artifact_summary(stderr_path, include_tail=True),
        },
        "final_message": _artifact_summary(final_message_path),
    }
    usage = _provider_usage(stdout_path)
    if usage:
        summary["usage"] = usage

    summary_path = step_dir / "trace-summary.json"
    try:
        _atomic_write_json(summary_path, summary)
        _compact_checkpoint(step_dir / "checkpoint.json")
        _update_result_metadata(result_path, summary_path, usage)
        runner._write_response_snapshot(context, step.id, result_path)
        _remove_raw_logs(stdout_path, stderr_path)
    except OSError:
        return None

    return {
        "trace_retention": "summary",
        "trace_summary_path": str(runner._relative_to_repo(summary_path, context)),
        "trace_contract_status": "accepted",
        **({"usage": usage} if usage else {}),
    }


def _accepted_contract(step, context, result_path: Path, final_message_path: Path, result) -> dict[str, Any] | None:
    if result.status is not StepStatus.SUCCEEDED:
        return None
    if not result_path.is_file() or not final_message_path.is_file():
        return None

    payload = _read_json(result_path)
    if payload.get("status") != StepStatus.SUCCEEDED.value:
        return None
    if payload.get("step_id") != step.id:
        return None

    outputs: list[dict[str, Any]] = []
    for relative in step.outputs:
        absolute = context.repo_root / relative
        snapshot = _artifact_summary(absolute)
        if not snapshot.get("present"):
            return None
        outputs.append({"path": str(relative), **snapshot})

    return {
        "step_id": step.id,
        "agent_id": step.agent_id,
        "result_status": StepStatus.SUCCEEDED.value,
        "declared_outputs": outputs,
        "final_message_path": str(_safe_relative_to_repo(final_message_path, context.repo_root)),
    }


def _safe_relative_to_repo(path: Path, repo_root: Path) -> Path:
    try:
        return path.relative_to(repo_root)
    except ValueError:
        return path


def _provider_usage(stdout_path: Path) -> dict[str, int | None]:
    merged = _empty_usage()
    found = False
    try:
        with stdout_path.open("r", encoding="utf-8") as stream:
            for line in stream:
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for candidate in _usage_candidates(event):
                    for key, value in candidate.items():
                        if value is not None:
                            merged[key] = value
                            found = True
    except OSError:
        return {}
    if not found:
        return {}
    if merged["total_tokens"] is None and all(
        isinstance(merged[key], int)
        for key in ("input_tokens", "output_tokens", "reasoning_tokens")
    ):
        merged["total_tokens"] = sum(
            int(merged[key]) for key in ("input_tokens", "output_tokens", "reasoning_tokens")
        )
    return {
        "input_tokens": merged["input_tokens"],
        "prompt_tokens": merged["input_tokens"],
        "cached_input_tokens": merged["cached_input_tokens"],
        "cached_prompt_tokens": merged["cached_input_tokens"],
        "output_tokens": merged["output_tokens"],
        "completion_tokens": merged["output_tokens"],
        "reasoning_tokens": merged["reasoning_tokens"],
        "total_tokens": merged["total_tokens"],
    }


def _usage_candidates(value: Any) -> list[dict[str, int | None]]:
    stack = [value]
    candidates: list[dict[str, int | None]] = []
    while stack:
        current = stack.pop()
        if isinstance(current, Mapping):
            source = current.get("usage") if isinstance(current.get("usage"), Mapping) else current
            candidate = _normalize_usage(source)
            if any(item is not None for item in candidate.values()):
                candidates.append(candidate)
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return candidates


def _normalize_usage(value: Mapping[str, Any]) -> dict[str, int | None]:
    aliases = {
        "input_tokens": ("input_tokens", "prompt_tokens"),
        "cached_input_tokens": ("cached_input_tokens", "cached_prompt_tokens"),
        "output_tokens": ("output_tokens", "completion_tokens"),
        "reasoning_tokens": ("reasoning_tokens",),
        "total_tokens": ("total_tokens",),
    }
    return {
        target: next(
            (
                value[key]
                for key in names
                if isinstance(value.get(key), int) and value[key] >= 0
            ),
            None,
        )
        for target, names in aliases.items()
    }


def _empty_usage() -> dict[str, int | None]:
    return {
        "input_tokens": None,
        "cached_input_tokens": None,
        "output_tokens": None,
        "reasoning_tokens": None,
        "total_tokens": None,
    }


def _artifact_summary(path: Path, *, include_tail: bool = False) -> dict[str, Any]:
    try:
        if path.is_file():
            size_bytes = path.stat().st_size
            summary: dict[str, Any] = {
                "present": True,
                "kind": "file",
                "bytes": size_bytes,
                "sha256": _sha256(path),
            }
            if include_tail and size_bytes:
                summary["tail"] = _tail(path)
            return summary
        if path.is_dir():
            return {
                "present": True,
                "kind": "directory",
                "files": sum(1 for child in path.rglob("*") if child.is_file()),
                "sha256": _directory_sha256(path),
            }
    except OSError:
        pass
    return {"present": False, "bytes": 0}


def _tail(path: Path) -> str:
    try:
        with path.open("rb") as stream:
            size_bytes = path.stat().st_size
            stream.seek(max(0, size_bytes - SUCCESS_STDERR_TAIL_BYTES), os.SEEK_SET)
            return stream.read(SUCCESS_STDERR_TAIL_BYTES).decode("utf-8", errors="replace").strip()
    except OSError:
        return ""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _directory_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        digest.update(str(child.relative_to(path)).encode("utf-8"))
        digest.update(_sha256(child).encode("ascii"))
    return digest.hexdigest()


def _compact_checkpoint(path: Path) -> None:
    if not path.is_file():
        return
    payload = _read_json(path)
    if not payload:
        return
    evidence_paths = payload.get("evidence_paths")
    if isinstance(evidence_paths, list):
        payload["evidence_paths"] = [
            item
            for item in evidence_paths
            if not str(item).replace("\\", "/").endswith("/stdout.txt")
        ]
    payload["trace_retention"] = "summary"
    _atomic_write_json(path, payload)


def _update_result_metadata(result_path: Path, summary_path: Path, usage: Mapping[str, Any]) -> None:
    payload = _read_json(result_path)
    metadata = payload.get("metadata")
    metadata = dict(metadata) if isinstance(metadata, Mapping) else {}
    metadata.pop("stdout_path", None)
    metadata.pop("stderr_path", None)
    metadata.update(
        {
            "trace_retention": "summary",
            "trace_summary_path": str(summary_path),
            "trace_contract_status": "accepted",
        }
    )
    if usage:
        metadata["usage"] = dict(usage)
    payload["metadata"] = metadata
    _atomic_write_json(result_path, payload)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _remove_raw_logs(stdout_path: Path, stderr_path: Path) -> None:
    step_dir = stdout_path.parent
    run_dir = step_dir.parent.parent
    step_id = step_dir.name
    for path in (
        stdout_path,
        stderr_path,
        run_dir / f"stdout-{step_id}.log",
        run_dir / f"stderr-{step_id}.log",
    ):
        try:
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError:
            continue
