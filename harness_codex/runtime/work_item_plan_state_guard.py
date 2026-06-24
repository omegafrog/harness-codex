"""Runner-level plan state guard that survives agent-handler patch ordering."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path


_COMPLETION_STEP_ID = "complete-work-item-plan"


def apply_work_item_plan_state_guard() -> None:
    """Guard active/completed plan state around every non-completion step."""

    from harness_codex.runtime.models import FailureKind, StepResult, StepStatus
    from harness_codex.runtime.plan_transition_policy_patch import (
        _active_plan_path,
        _capture_plan_location,
        _completed_plan_path,
        _plan_transition_error,
        _recover_plan_for_retry,
        _restore_plan_location,
    )
    import harness_codex.runtime.runner as runner_module

    basic_step_runner = runner_module.BasicStepRunner
    if getattr(basic_step_runner, "_work_item_plan_state_guard_applied", False):
        return

    original_run = basic_step_runner.run

    def run(self, step, context):
        active_path = _active_plan_path(step, context)
        if active_path is None or step.id == _COMPLETION_STEP_ID:
            return original_run(self, step, context)
        completed_path = _completed_plan_path(active_path)
        step_dir = context.run_dir / "steps" / step.id

        recovery_error = _recover_plan_for_retry(active_path, completed_path)
        if recovery_error is not None:
            return _blocked_result(
                runner_module,
                step,
                context,
                step_dir,
                recovery_error,
                FailureKind,
                StepResult,
                StepStatus,
            )

        before = _capture_plan_location(active_path, completed_path)
        result = original_run(self, step, context)
        after = _capture_plan_location(active_path, completed_path)
        transition_error = _plan_transition_error(step, before, after)
        if transition_error is None:
            return result

        _restore_plan_location(before)
        evidence = _write_evidence(
            step_dir,
            step_id=step.id,
            active_path=active_path,
            completed_path=completed_path,
            error=transition_error,
        )
        metadata = {
            **dict(result.metadata),
            "plan_transition_status": "blocked",
            "plan_transition_evidence": str(_relative_to_repo(evidence, context)),
        }
        return replace(
            result,
            status=StepStatus.BLOCKED,
            error=transition_error,
            failure_kind=FailureKind.SCOPE_CONFLICT,
            metadata=metadata,
        )

    basic_step_runner.run = run
    basic_step_runner._work_item_plan_state_guard_applied = True


def _blocked_result(
    runner_module,
    step,
    context,
    step_dir: Path,
    error: str,
    failure_kind,
    step_result,
    step_status,
):
    active_path = _active_path_for_evidence(step, context)
    completed_path = (
        Path("docs/plans/completed") / active_path.parts[3] / "plan.md"
        if active_path is not None
        else None
    )
    evidence = _write_evidence(
        step_dir,
        step_id=step.id,
        active_path=active_path,
        completed_path=completed_path,
        error=error,
    )
    return step_result(
        step_id=step.id,
        status=step_status.BLOCKED,
        output_path=runner_module._relative_to_repo(evidence, context),
        error=error,
        failure_kind=failure_kind.SCOPE_CONFLICT,
        metadata={
            "plan_transition_status": "blocked",
            "plan_transition_evidence": str(_relative_to_repo(evidence, context)),
        },
    )


def _active_path_for_evidence(step, context) -> Path | None:
    from harness_codex.runtime.plan_transition_policy_patch import _active_plan_path

    return _active_plan_path(step, context)


def _write_evidence(
    step_dir: Path,
    *,
    step_id: str,
    active_path: Path | None,
    completed_path: Path | None,
    error: str,
) -> Path:
    step_dir.mkdir(parents=True, exist_ok=True)
    evidence = step_dir / "plan-transition.json"
    evidence.write_text(
        json.dumps(
            {
                "step_id": step_id,
                "status": "blocked",
                "active_plan_path": str(active_path) if active_path is not None else None,
                "completed_plan_path": str(completed_path) if completed_path is not None else None,
                "error": error,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return evidence


def _relative_to_repo(path: Path, context) -> Path:
    try:
        return path.relative_to(context.repo_root)
    except ValueError:
        return path
