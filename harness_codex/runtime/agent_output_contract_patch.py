"""Fail closed when an agent creates malformed declared output artifacts."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path


def apply_agent_output_contract_patch() -> None:
    """Extend output validation and cover cached-agent early returns.

    The base runner validates normal provider results before writing `result.json`,
    but review-cache hits return early. The finalizer validates both paths and
    rewrites the persisted result if a cached output violates the declaration.
    """

    import harness_codex.runtime.runner as runner
    from harness_codex.runtime.models import FailureKind, StepStatus

    original_validate = runner._validate_agent_outputs
    if not getattr(original_validate, "_agent_output_contract_patch", False):
        def validate_agent_outputs(step, context):
            error = original_validate(step, context)
            if error:
                return error
            return _validate_declared_output_shapes(step, context.repo_root)

        validate_agent_outputs._agent_output_contract_patch = True
        runner._validate_agent_outputs = validate_agent_outputs

    BasicStepRunner = runner.BasicStepRunner
    if getattr(BasicStepRunner, "_agent_output_contract_finalizer_patch", False):
        return
    original_run_agent = BasicStepRunner._run_agent

    def run_agent(self, step, context, step_dir: Path):
        result = original_run_agent(self, step, context, step_dir)
        if result.status is not StepStatus.SUCCEEDED:
            return result
        error = _validate_declared_output_shapes(step, context.repo_root)
        if error is None:
            return result

        failed = replace(
            result,
            status=StepStatus.FAILED,
            error=error,
            failure_kind=FailureKind.IMPLEMENTATION,
            metadata={**dict(result.metadata), "output_contract_status": "failed"},
        )
        _persist_output_contract_failure(runner, context, step, step_dir, failed)
        return failed

    BasicStepRunner._run_agent = run_agent
    BasicStepRunner._agent_output_contract_finalizer_patch = True


def _validate_declared_output_shapes(step, repo_root: Path) -> str | None:
    text_suffixes = {".md", ".json", ".txt", ".yaml", ".yml", ".toml"}
    for relative in step.outputs:
        path = repo_root / relative
        if path.is_symlink():
            return f"agent output must not be a symlink: {relative}"
        if Path(relative).suffix and not path.is_file():
            return f"agent output must be a regular file: {relative}"
        if path.is_file() and Path(relative).suffix.lower() in text_suffixes:
            try:
                if path.stat().st_size == 0:
                    return f"agent output must not be empty: {relative}"
            except OSError:
                return f"agent output is unreadable: {relative}"
    return None


def _persist_output_contract_failure(runner, context, step, step_dir: Path, result) -> None:
    path = step_dir / "result.json"
    payload = _read_json(path)
    payload.update(
        {
            "step_id": step.id,
            "agent_id": step.agent_id,
            "status": result.status.value,
            "exit_code": result.exit_code,
            "error": result.error,
            "failure_kind": result.failure_kind.value if result.failure_kind else None,
            "metadata": dict(result.metadata),
        }
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    runner._write_response_snapshot(context, step.id, path)


def _read_json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}
