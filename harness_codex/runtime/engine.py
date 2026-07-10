"""Workflow execution engine.

The engine is a local execution platform: it validates workflow ordering, applies
command policy checks, runs declared steps, records the step ledger, and returns a
terminal result. It does not own workflow-brain behavior such as retry loops,
remediation routing, owner-stage selection, or resume-target selection.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace
from typing import Callable

from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunMode,
    RunResult,
    RunStatus,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.dependency_gate import check_step_dependencies
from harness_codex.runtime.policy import CommandRequest, PolicyDecision, PolicyEngine
from harness_codex.runtime.runner import StepRunner
from harness_codex.runtime.step_transaction_store import StepTransactionStore
class WorkflowValidationError(ValueError):
    """Raised when a workflow graph cannot be executed safely."""


@dataclass(frozen=True)
class ExecutionPlan:
    """Validated execution order for a workflow."""

    steps: tuple[Step, ...]

    def step_ids(self) -> tuple[str, ...]:
        return tuple(step.id for step in self.steps)


class RunnerEngine:
    """Execute the declared workflow graph through a ``StepRunner`` boundary."""

    def __init__(
        self,
        step_runner: StepRunner,
        policy_engine: PolicyEngine | None = None,
        progress_emit: Callable[[str], None] | None = None,
    ) -> None:
        self._step_runner = step_runner
        self._policy_engine = policy_engine or PolicyEngine()
        self._progress_emit = progress_emit

    def set_progress_emit(self, progress_emit: Callable[[str], None] | None) -> None:
        self._progress_emit = progress_emit

    def plan(self, workflow: Workflow) -> ExecutionPlan:
        steps_by_id = self._index_steps(workflow)
        ordered_ids = self._topological_sort(workflow, steps_by_id)
        return ExecutionPlan(steps=tuple(steps_by_id[step_id] for step_id in ordered_ids))

    def run(self, workflow: Workflow, context: RunContext) -> RunResult:
        execution_plan = self.plan(workflow)
        if context.mode in (RunMode.PLAN, RunMode.PREVIEW):
            return self._dry_run_result(execution_plan, context)

        results: list[StepResult] = []
        for step in execution_plan.steps:
            dependency_check = check_step_dependencies(
                workflow=workflow,
                target_step_id=step.id,
                step_results={result.step_id: result for result in results},
            )
            if not dependency_check.allowed:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error="workflow dependency gate failed",
                    metadata={
                        "dependency_violations": tuple(
                            {
                                "code": violation.code,
                                "dependency_step_id": violation.dependency_step_id,
                                "expected_outcomes": violation.expected_outcomes,
                                "actual_outcome": violation.actual_outcome,
                            }
                            for violation in dependency_check.violations
                        )
                    },
                )
                self._record_terminal_step(step, context, result)
                results.append(result)
                self._emit_step_result(step, result)
                return self._terminal_result(
                    execution_plan,
                    context,
                    tuple(results),
                    result,
                    RunStatus.BLOCKED,
                    blocker=result.error,
                )
            skip_reason = self._work_item_step_skip_reason(step, context)
            if skip_reason is not None:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.SKIPPED,
                    metadata={
                        "reason": skip_reason,
                        "precompleted_work_item": bool(
                            context.metadata.get("skip_precompleted_work_item_steps")
                        ),
                    },
                )
                self._record_terminal_step(step, context, result)
                results.append(result)
                self._emit_step_result(step, result)
                continue

            decision_blocker = self._runtime_decision_step_blocker(step)
            if decision_blocker is not None:
                self._record_terminal_step(step, context, decision_blocker)
                results.append(decision_blocker)
                self._emit_step_result(step, decision_blocker)
                return self._terminal_result(
                    execution_plan,
                    context,
                    tuple(results),
                    decision_blocker,
                    RunStatus.BLOCKED,
                    blocker=decision_blocker.error,
                )

            policy_decision = self._evaluate_command_policy(step, context)
            if policy_decision is not None and not policy_decision.allowed:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error=policy_decision.reason,
                    metadata={"policy_decision": policy_decision.as_metadata()},
                )
                self._record_terminal_step(step, context, result)
                results.append(result)
                self._emit_step_result(step, result)
                return self._terminal_result(
                    execution_plan,
                    context,
                    tuple(results),
                    result,
                    RunStatus.BLOCKED,
                    blocker=policy_decision.reason,
                )

            result = self._run_step(step, context)
            if policy_decision is not None:
                result = replace(
                    result,
                    metadata={
                        **dict(result.metadata),
                        "policy_decision": policy_decision.as_metadata(),
                    },
                )
            results.append(result)
            self._emit_step_result(step, result)

            if result.status == StepStatus.BLOCKED:
                return self._terminal_result(
                    execution_plan,
                    context,
                    tuple(results),
                    result,
                    RunStatus.BLOCKED,
                    blocker=result.error,
                )
            if result.status == StepStatus.FAILED:
                return self._terminal_result(
                    execution_plan,
                    context,
                    tuple(results),
                    result,
                    RunStatus.FAILED,
                    blocker=result.error,
                )

        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=tuple(results),
            mode=context.mode,
            metadata=self._result_metadata(execution_plan, context, tuple(results)),
        )

    def _run_step(self, step: Step, context: RunContext) -> StepResult:
        """Run one side-effecting step inside the durable SQLite ledger boundary."""

        if context.mode is not RunMode.APPLY:
            return self._step_runner.run(step, context)
        store = StepTransactionStore(context.repo_root, context.run_id)
        transaction = store.begin(step, context)
        try:
            result = self._step_runner.run(step, context)
        except BaseException as exc:
            store.finish(
                transaction,
                step,
                context,
                StepResult(
                    step_id=step.id,
                    status=StepStatus.FAILED,
                    error=f"{type(exc).__name__}: {exc}",
                ),
            )
            raise
        return store.finish(transaction, step, context, result)

    def _record_terminal_step(self, step: Step, context: RunContext, result: StepResult) -> None:
        """Persist a skipped or policy-blocked terminal decision in the same ledger."""

        if context.mode is not RunMode.APPLY:
            return
        store = StepTransactionStore(context.repo_root, context.run_id)
        transaction = store.begin(step, context)
        store.finish(transaction, step, context, result)

    def _dry_run_result(self, execution_plan: ExecutionPlan, context: RunContext) -> RunResult:
        step_results: list[StepResult] = []
        for step in execution_plan.steps:
            decision_blocker = self._runtime_decision_step_blocker(step)
            if decision_blocker is not None:
                step_results.append(decision_blocker)
                self._emit_step_result(step, decision_blocker)
                return self._terminal_result(
                    execution_plan,
                    context,
                    tuple(step_results),
                    decision_blocker,
                    RunStatus.BLOCKED,
                    blocker=decision_blocker.error,
                )
            decision = self._evaluate_command_policy(step, context)
            if decision is not None and not decision.allowed:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error=decision.reason,
                    metadata={"policy_decision": decision.as_metadata()},
                )
                step_results.append(result)
                return self._terminal_result(
                    execution_plan,
                    context,
                    tuple(step_results),
                    result,
                    RunStatus.BLOCKED,
                    blocker=decision.reason,
                )
            metadata = {
                "mode": context.mode.value,
                "would_run": context.mode == RunMode.PREVIEW,
                "side_effects": False,
            }
            if decision is not None:
                metadata["policy_decision"] = decision.as_metadata()
            result = StepResult(step_id=step.id, status=StepStatus.SKIPPED, metadata=metadata)
            step_results.append(result)
            self._emit_step_result(step, result)
        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=tuple(step_results),
            mode=context.mode,
            metadata=self._result_metadata(execution_plan, context, tuple(step_results)),
        )

    def _terminal_result(
        self,
        execution_plan: ExecutionPlan,
        context: RunContext,
        step_results: tuple[StepResult, ...],
        result: StepResult,
        status: RunStatus,
        *,
        blocker: str | None,
    ) -> RunResult:
        return RunResult(
            run_id=context.run_id,
            status=status,
            step_results=step_results,
            mode=context.mode,
            failed_step_id=result.step_id,
            failure_kind=result.failure_kind,
            blocker=blocker,
            retry_count=0,
            metadata=self._result_metadata(execution_plan, context, step_results),
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
        agent_attempts = tuple(
            {
                "step_id": result.step_id,
                "execution_mode": result.metadata.get("execution_mode"),
                "attempt": result.metadata.get("attempt"),
                "provider_session_id": result.metadata.get("provider_session_id"),
                "termination_reason": result.metadata.get("termination_reason"),
                "checkpoint_path": result.metadata.get("checkpoint_path"),
            }
            for result in step_results
            if "execution_mode" in result.metadata
        )
        phase_metrics = tuple(
            {"step_id": result.step_id, "phase_metrics": result.metadata["phase_metrics"]}
            for result in step_results
            if "phase_metrics" in result.metadata
        )
        return {
            "mode": context.mode.value,
            "workflow_name": context.workflow_name,
            "planned_steps": execution_plan.step_ids(),
            "side_effects": context.mode == RunMode.APPLY,
            "policy_decisions": policy_decisions,
            "agent_attempts": agent_attempts,
            "phase_metrics": phase_metrics,
        }

    def _work_item_step_skip_reason(self, step: Step, context: RunContext) -> str | None:
        if context.metadata.get("run_ready_work_item_completion_only"):
            if (
                step.metadata.get("scope") == "work_item"
                and step.id not in {"complete-work-item-plan", "complete-use-case-plan"}
            ):
                return "work item plan is ready; running only plan completion transition"
            return None
        if (
            context.metadata.get("skip_existing_active_plan_planning")
            and step.id == "plan-work-item"
        ):
            return "active work-item plan already exists; skipping planning mutation"
        if (
            context.metadata.get("skip_precompleted_work_item_steps")
            and step.metadata.get("scope") == "work_item"
        ):
            return "work item was completed before this run"
        return None

    def _runtime_decision_step_blocker(self, step: Step) -> StepResult | None:
        if step.kind is not StepKind.DECISION:
            return None
        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            error="decision steps belong to the orchestration agent, not runtime execution",
            failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
            metadata={
                "runtime_contract": "decision-step-not-executed",
                "orchestration_owner": "orchestration-agent",
            },
        )

    def _evaluate_command_policy(self, step: Step, context: RunContext) -> PolicyDecision | None:
        if step.command is None or step.kind not in {StepKind.GIT, StepKind.SHELL, StepKind.VALIDATOR}:
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
            for dependency in step.needs:
                if dependency.step_id not in steps_by_id:
                    raise WorkflowValidationError(
                        f"Step {step.id} depends on unknown step: {dependency.step_id}"
                    )
        return steps_by_id

    def _topological_sort(self, workflow: Workflow, steps_by_id: dict[str, Step]) -> tuple[str, ...]:
        dependents_by_step_id: dict[str, list[str]] = {step.id: [] for step in workflow.steps}
        remaining_needs_count: dict[str, int] = {step.id: len(step.needs) for step in workflow.steps}
        for step in workflow.steps:
            for dependency in step.needs:
                dependents_by_step_id[dependency.step_id].append(step.id)
        ready = deque(step.id for step in workflow.steps if remaining_needs_count[step.id] == 0)
        ordered: list[str] = []
        while ready:
            step_id = ready.popleft()
            ordered.append(step_id)
            for dependent_step_id in dependents_by_step_id[step_id]:
                remaining_needs_count[dependent_step_id] -= 1
                if remaining_needs_count[dependent_step_id] == 0:
                    ready.append(dependent_step_id)
        if len(ordered) != len(steps_by_id):
            unresolved = tuple(step_id for step_id, count in remaining_needs_count.items() if count > 0)
            raise WorkflowValidationError(
                "Workflow contains cyclic step dependencies: " + ", ".join(unresolved)
            )
        return tuple(ordered)

    def _emit_step_result(self, step: Step, result: StepResult) -> None:
        if self._progress_emit is None:
            return
        self._progress_emit(f"{step.id}: {result.status.value}")
