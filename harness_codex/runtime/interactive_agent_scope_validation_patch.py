"""Validate direct interactive agent writes against declared outputs."""

from __future__ import annotations

import json
from pathlib import Path


def apply_interactive_agent_scope_validation_patch() -> None:
    """Wrap interactive adapter calls with a post-execution scope validator.

    Interactive UI calls bypass ``BasicStepRunner._run_agent`` and therefore do not
    receive the standard agent write policy. The inner transaction wrapper records
    the provider attempt; this outer wrapper records a separate blocked validator
    transaction only when the actual worktree delta escapes declared outputs.
    """

    import harness_codex.runtime.runner as runner
    from harness_codex.runtime.interactive_agent_transaction_patch import (
        _write_interactive_result,
    )
    from harness_codex.runtime.models import FailureKind, Step, StepKind, StepResult, StepStatus
    from harness_codex.runtime.step_transaction_store import StepTransactionStore

    original_run = runner.ConfigurableCliAgentAdapter.run
    if getattr(original_run, "_interactive_agent_scope_validation_patch", False):
        return

    def run(self, request):
        if not request.step.metadata.get("interactive"):
            return original_run(self, request)

        before = _capture_snapshot(request.context.repo_root)
        result = original_run(self, request)
        blocked = _blocked_paths(request, before)
        if not blocked:
            return result

        error = "interactive agent wrote outside declared outputs: " + ", ".join(blocked)
        validator = Step(
            id=f"{request.step.id}-interactive-scope-validation",
            kind=StepKind.VALIDATOR,
            name=f"Validate interactive write scope for {request.step.id}",
            inputs=tuple(request.step.outputs),
            metadata={
                "interactive": True,
                "validator_for": request.step.id,
                "blocked_files": tuple(blocked),
            },
        )
        store = StepTransactionStore(request.context.repo_root, request.context.run_id)
        transaction = store.begin(validator, request.context)
        validation_result = store.finish(
            transaction,
            validator,
            request.context,
            StepResult(
                step_id=validator.id,
                status=StepStatus.BLOCKED,
                error=error,
                failure_kind=FailureKind.SCOPE_CONFLICT,
                metadata={"blocked_files": tuple(blocked)},
            ),
        )
        _write_scope_receipt(request.step_dir, request.step.id, blocked, validation_result)
        blocked_result = runner.AgentRunResult(
            status=StepStatus.BLOCKED,
            exit_code=result.exit_code,
            error=error,
            metadata={
                **dict(result.metadata),
                "interactive_scope_status": "blocked",
                "interactive_scope_blocked_files": tuple(blocked),
                "interactive_scope_transaction_id": transaction.transaction_id,
            },
        )
        _write_interactive_result(
            request.step_dir,
            StepResult(
                step_id=request.step.id,
                status=StepStatus.BLOCKED,
                exit_code=result.exit_code,
                error=error,
                failure_kind=FailureKind.SCOPE_CONFLICT,
                metadata=dict(blocked_result.metadata),
            ),
        )
        runner._write_response_snapshot(
            request.context,
            request.step.id,
            request.step_dir / "result.json",
        )
        return blocked_result

    run._interactive_agent_scope_validation_patch = True
    runner.ConfigurableCliAgentAdapter.run = run


def _capture_snapshot(repo_root: Path):
    from harness_codex.runtime.agent_write_scope_policy_patch import (
        _capture_worktree_snapshot,
        _inside_git_work_tree,
    )

    if not _inside_git_work_tree(repo_root):
        return None
    return _capture_worktree_snapshot(repo_root)


def _blocked_paths(request, before) -> list[str]:
    if before is None:
        return []
    after = _capture_snapshot(request.context.repo_root)
    if after is None:
        return ["<unable to capture interactive write scope>"]
    changed = sorted(
        path for path in set(before) | set(after) if before.get(path) != after.get(path)
    )
    return [path for path in changed if not _is_declared_output(path, request.step.outputs)]


def _is_declared_output(path: str, outputs) -> bool:
    for output in outputs:
        declared = str(Path(str(output))).rstrip("/")
        if not declared:
            continue
        if Path(declared).suffix:
            if path == declared:
                return True
        elif path == declared or path.startswith(declared + "/"):
            return True
    return False


def _write_scope_receipt(step_dir: Path, step_id: str, blocked: list[str], result) -> None:
    path = step_dir / "interactive-scope-validation.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "step_id": step_id,
                "status": result.status.value,
                "error": result.error,
                "blocked_files": blocked,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
