"""Pure workflow execution engine.

The engine owns ordering, dependency checks, status aggregation, and failure
handling.

It does not directly call Codex, shell, git, validators, or any other
side-effecting tool.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

from harness_codex.runtime.models import (
    RunContext,
    RunResult,
    RunStatus,
    Step,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.runner import StepRunner


class WorkflowValidationError(ValueError):
    """Raised when a workflow graph cannot be executed safely."""


@dataclass(frozen=True)
class ExecutionPlan:
    """Validated execution order for a workflow."""

    steps: tuple[Step, ...]

    def step_ids(self) -> tuple[str, ...]:
        """Return step IDs in execution order."""

        return tuple(step.id for step in self.steps)


class RunnerEngine:
    """Execute workflows through a side-effecting `StepRunner` boundary."""

    def __init__(self, step_runner: StepRunner) -> None:
        self._step_runner = step_runner

    def plan(self, workflow: Workflow) -> ExecutionPlan:
        """Validate the workflow and return dependency-safe execution order."""

        steps_by_id = self._index_steps(workflow)
        ordered_ids = self._topological_sort(workflow, steps_by_id)

        return ExecutionPlan(
            steps=tuple(steps_by_id[step_id] for step_id in ordered_ids)
        )

    def run(self, workflow: Workflow, context: RunContext) -> RunResult:
        """Run the workflow until all steps succeed or one step fails/blocks."""

        execution_plan = self.plan(workflow)
        results: list[StepResult] = []

        for step in execution_plan.steps:
            result = self._step_runner.run(step, context)
            results.append(result)

            if result.status == StepStatus.FAILED:
                return RunResult(
                    run_id=context.run_id,
                    status=RunStatus.FAILED,
                    step_results=tuple(results),
                    failed_step_id=step.id,
                    blocker=result.error,
                )

            if result.status == StepStatus.BLOCKED:
                return RunResult(
                    run_id=context.run_id,
                    status=RunStatus.BLOCKED,
                    step_results=tuple(results),
                    failed_step_id=step.id,
                    blocker=result.error,
                )

        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=tuple(results),
        )

    def _index_steps(self, workflow: Workflow) -> dict[str, Step]:
        steps_by_id: dict[str, Step] = {}

        for step in workflow.steps:
            if step.id in steps_by_id:
                raise WorkflowValidationError(f"Duplicate step id: {step.id}")

            steps_by_id[step.id] = step

        for step in workflow.steps:
            for needed_step_id in step.needs:
                if needed_step_id not in steps_by_id:
                    raise WorkflowValidationError(
                        f"Step {step.id} depends on unknown step: {needed_step_id}"
                    )

        return steps_by_id

    def _topological_sort(
        self,
        workflow: Workflow,
        steps_by_id: dict[str, Step],
    ) -> tuple[str, ...]:
        dependents_by_step_id: dict[str, list[str]] = {
            step.id: [] for step in workflow.steps
        }
        remaining_needs_count: dict[str, int] = {
            step.id: len(step.needs) for step in workflow.steps
        }

        for step in workflow.steps:
            for needed_step_id in step.needs:
                dependents_by_step_id[needed_step_id].append(step.id)

        ready = deque(
            step.id for step in workflow.steps if remaining_needs_count[step.id] == 0
        )

        ordered: list[str] = []

        while ready:
            step_id = ready.popleft()
            ordered.append(step_id)

            for dependent_step_id in dependents_by_step_id[step_id]:
                remaining_needs_count[dependent_step_id] -= 1

                if remaining_needs_count[dependent_step_id] == 0:
                    ready.append(dependent_step_id)

        if len(ordered) != len(steps_by_id):
            unresolved = tuple(
                step_id for step_id, count in remaining_needs_count.items() if count > 0
            )

            raise WorkflowValidationError(
                "Workflow contains cyclic step dependencies: " + ", ".join(unresolved)
            )

        return tuple(ordered)
