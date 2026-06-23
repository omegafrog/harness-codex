"""Attach materialized gate-policy decisions to the workflow engine."""

from __future__ import annotations

from dataclasses import replace
from typing import Mapping


def apply_gate_policy_runner_patch() -> None:
    """Skip steps whose materialized gate policy explicitly says ``skipped``.

    The wrapper preserves the engine's execution semantics for all applicable
    steps. It records skipped step results and the complete applied policy in the
    final run metadata so reports and RunState can explain why a gate was absent.
    """

    from harness_codex.runtime.engine import RunnerEngine
    from harness_codex.runtime.models import Step, StepResult, StepStatus, Workflow

    if getattr(RunnerEngine, "_gate_policy_patch_applied", False):
        return

    original_run = RunnerEngine.run

    def run(self, workflow: Workflow, context):
        skipped_steps = tuple(
            step
            for step in workflow.steps
            if _is_policy_skipped(step)
        )
        if not skipped_steps:
            return original_run(self, workflow, context)

        skipped_ids = {step.id for step in skipped_steps}
        executable_steps = tuple(
            replace(step, needs=tuple(need for need in step.needs if need not in skipped_ids))
            for step in workflow.steps
            if step.id not in skipped_ids
        )
        executable_workflow = replace(workflow, steps=executable_steps)
        result = original_run(self, executable_workflow, context)
        skipped_results = tuple(_skipped_result(step) for step in skipped_steps)
        metadata = {
            **dict(result.metadata),
            "gate_policy": dict(workflow.metadata.get("gate_policy", {})),
            "skipped_gates": [
                dict(step.metadata.get("gate_policy", {}))
                for step in skipped_steps
            ],
        }
        return replace(
            result,
            step_results=(*skipped_results, *result.step_results),
            metadata=metadata,
        )

    RunnerEngine.run = run
    RunnerEngine._gate_policy_patch_applied = True


def _is_policy_skipped(step: Step) -> bool:
    decision = step.metadata.get("gate_policy")
    return isinstance(decision, Mapping) and decision.get("requirement") == "skipped"


def _skipped_result(step: Step) -> StepResult:
    decision = dict(step.metadata.get("gate_policy", {}))
    return StepResult(
        step_id=step.id,
        status=StepStatus.SKIPPED,
        metadata={
            "reason": decision.get("reason", "gate is not applicable to this work item"),
            "gate_policy": decision,
        },
    )
