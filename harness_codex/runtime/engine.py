"""Pure workflow execution engine.

The engine owns ordering, dependency checks, status aggregation, and failure
handling. It does not directly call Codex, shell, git, validators, or any other
side-effecting tool.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace

from harness_codex.runtime.models import (
    RunContext,
    RunResult,
    RunStatus,
    RunMode,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.policy import CommandRequest, PolicyDecision, PolicyEngine
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

    def __init__(
        self,
        step_runner: StepRunner,
        policy_engine: PolicyEngine | None = None,
    ) -> None:
        self._step_runner = step_runner
        self._policy_engine = policy_engine or PolicyEngine()

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

        if context.mode in (RunMode.PLAN, RunMode.PREVIEW):
            return self._dry_run_result(execution_plan, context)

        results: list[StepResult] = []

        for step in execution_plan.steps:
            decision = self._evaluate_command_policy(step, context)
            if decision is not None and not decision.allowed:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error=decision.reason,
                    metadata={"policy_decision": decision.as_metadata()},
                )
                results.append(result)

                return RunResult(
                    run_id=context.run_id,
                    status=RunStatus.BLOCKED,
                    step_results=tuple(results),
                    mode=context.mode,
                    failed_step_id=step.id,
                    blocker=decision.reason,
                    metadata=self._result_metadata(
                        execution_plan,
                        context,
                        tuple(results),
                    ),
                )

            result = self._step_runner.run(step, context)
            if decision is not None:
                result = replace(
                    result,
                    metadata={
                        **dict(result.metadata),
                        "policy_decision": decision.as_metadata(),
                    },
                )
            results.append(result)

            if result.status == StepStatus.FAILED:
                return RunResult(
                    run_id=context.run_id,
                    status=RunStatus.FAILED,
                    step_results=tuple(results),
                    mode=context.mode,
                    failed_step_id=step.id,
                    blocker=result.error,
                    metadata=self._result_metadata(
                        execution_plan,
                        context,
                        tuple(results),
                    ),
                )

            if result.status == StepStatus.BLOCKED:
                return RunResult(
                    run_id=context.run_id,
                    status=RunStatus.BLOCKED,
                    step_results=tuple(results),
                    mode=context.mode,
                    failed_step_id=step.id,
                    blocker=result.error,
                    metadata=self._result_metadata(
                        execution_plan,
                        context,
                        tuple(results),
                    ),
                )

        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=tuple(results),
            mode=context.mode,
            metadata=self._result_metadata(execution_plan, context, tuple(results)),
        )

    def _dry_run_result(
        self,
        execution_plan: ExecutionPlan,
        context: RunContext,
    ) -> RunResult:
        step_results: list[StepResult] = []

        for step in execution_plan.steps:
            decision = self._evaluate_command_policy(step, context)
            if decision is not None and not decision.allowed:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error=decision.reason,
                    metadata={"policy_decision": decision.as_metadata()},
                )
                step_results.append(result)

                return RunResult(
                    run_id=context.run_id,
                    status=RunStatus.BLOCKED,
                    step_results=tuple(step_results),
                    mode=context.mode,
                    failed_step_id=step.id,
                    blocker=decision.reason,
                    metadata=self._result_metadata(
                        execution_plan,
                        context,
                        tuple(step_results),
                    ),
                )

            metadata = {
                "mode": context.mode.value,
                "would_run": context.mode == RunMode.PREVIEW,
                "side_effects": False,
            }

            if decision is not None:
                metadata["policy_decision"] = decision.as_metadata()

            step_results.append(
                StepResult(
                    step_id=step.id,
                    status=StepStatus.SKIPPED,
                    metadata=metadata,
                )
            )

        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=tuple(step_results),
            mode=context.mode,
            metadata=self._result_metadata(
                execution_plan,
                context,
                tuple(step_results),
            ),
        )

    def _result_metadata(
        self,
        execution_plan: ExecutionPlan,
        context: RunContext,
        step_results: tuple[StepResult, ...] = (),
    ) -> dict[str, object]:
        policy_decisions = tuple(
            result.metadata["policy_decision"]
            for result in step_results
            if "policy_decision" in result.metadata
        )

        return {
            "mode": context.mode.value,
            "workflow_name": context.workflow_name,
            "planned_steps": execution_plan.step_ids(),
            "side_effects": context.mode == RunMode.APPLY,
            "policy_decisions": policy_decisions,
        }

    def _evaluate_command_policy(
        self,
        step: Step,
        context: RunContext,
    ) -> PolicyDecision | None:
        if step.command is None:
            return None

        if step.kind not in {StepKind.GIT, StepKind.SHELL, StepKind.VALIDATOR}:
            return None

        return self._policy_engine.evaluate(
            CommandRequest(
                step_id=step.id,
                step_kind=step.kind,
                command=step.command,
                mode=context.mode,
                repo_root=context.repo_root,
                workdir=context.workdir,
            )
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
