"""Runtime boundary for executing one orchestrator-selected step.

The orchestration agent owns workflow progression. This module exposes the local
runtime entrypoint that receives one already-selected step, executes it through
runtime services, and returns the step result without choosing the next route.
"""

from __future__ import annotations

from dataclasses import replace

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.local_step_runner import LocalStepRunner
from harness_codex.runtime.models import RunContext, Step, StepResult, Workflow


class SelectedStepRuntimeExecutor:
    """Execute exactly one step selected by the orchestration agent."""

    def __init__(self, engine: RunnerEngine | None = None) -> None:
        self._engine = engine or RunnerEngine(LocalStepRunner())

    def execute_selected_step(self, step: Step, context: RunContext) -> StepResult:
        """Run one selected step and return its result, never a next-step decision."""

        selected_step = replace(step, needs=())
        workflow = Workflow(
            name=f"selected-step:{selected_step.id}",
            mode=context.mode,
            steps=(selected_step,),
        )
        result = self._engine.run(workflow, context)
        if not result.step_results:
            raise RuntimeError(f"selected step produced no result: {selected_step.id}")
        return result.step_results[-1]


def execute_selected_step(step: Step, context: RunContext) -> StepResult:
    """Convenience runtime API used by orchestration-agent adapters."""

    return SelectedStepRuntimeExecutor().execute_selected_step(step, context)
