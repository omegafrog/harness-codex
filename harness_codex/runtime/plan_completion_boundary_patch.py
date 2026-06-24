"""Reserve plan archive moves for the explicit work-item completion step."""

from __future__ import annotations

import json
from pathlib import Path


_WORK_ITEM_WORKFLOW = "changeset-work-item-workflow"
_COMPLETION_STEP_ID = "complete-work-item-plan"


def apply_plan_completion_boundary_patch() -> None:
    """Block active-to-completed plan moves from non-completion git steps."""

    from harness_codex.runtime.models import FailureKind, StepResult, StepStatus
    import harness_codex.runtime.runner as runner_module

    basic_step_runner = runner_module.BasicStepRunner
    if getattr(basic_step_runner, "_plan_completion_boundary_patch_applied", False):
        return

    original_run_git_boundary = basic_step_runner._run_git_boundary

    def run_git_boundary(self, step, context, step_dir: Path):
        if not _is_disallowed_plan_completion_move(step, context, runner_module):
            return original_run_git_boundary(self, step, context, step_dir)

        error = (
            "plan transition blocked: only `complete-work-item-plan` may move an "
            "active work-item plan to the completed path"
        )
        evidence = step_dir / "plan-transition.json"
        evidence.write_text(
            json.dumps(
                {
                    "step_id": step.id,
                    "status": "blocked",
                    "error": error,
                    "expected_completion_step": _COMPLETION_STEP_ID,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            output_path=runner_module._relative_to_repo(evidence, context),
            error=error,
            failure_kind=FailureKind.SCOPE_CONFLICT,
            metadata={"plan_transition_status": "blocked"},
        )

    basic_step_runner._run_git_boundary = run_git_boundary
    basic_step_runner._plan_completion_boundary_patch_applied = True


def _is_disallowed_plan_completion_move(step, context, runner_module) -> bool:
    if context.workflow_name != _WORK_ITEM_WORKFLOW:
        return False
    if step.id == _COMPLETION_STEP_ID:
        return False
    if len(step.inputs) != 1 or len(step.outputs) != 1:
        return False
    return runner_module._is_plan_completion_move(step.inputs[0], step.outputs[0])
