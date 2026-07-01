"""Pure workflow execution engine.

The engine owns ordering, dependency checks, status aggregation, and failure
handling. It does not directly call Codex, shell, git, validators, or any other
side-effecting tool.
"""

from __future__ import annotations

import json
from collections import deque
from dataclasses import dataclass, replace
from pathlib import Path

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
from harness_codex.runtime.policy import CommandRequest, PolicyDecision, PolicyEngine
from harness_codex.runtime.runner import StepRunner
from harness_codex.runtime.verification_failure import (
    VerificationFailureClass,
    structured_failure_from_report,
)


class WorkflowValidationError(ValueError):
    """Raised when a workflow graph cannot be executed safely."""


@dataclass(frozen=True)
class ExecutionPlan:
    """Validated execution order for a workflow."""

    steps: tuple[Step, ...]

    def step_ids(self) -> tuple[str, ...]:
        return tuple(step.id for step in self.steps)


@dataclass(frozen=True)
class _RemediationPath:
    decision_step: Step | None
    remediation_step: Step
    loop_target_step: Step


class RunnerEngine:
    """Execute workflows through a side-effecting ``StepRunner`` boundary."""

    def __init__(
        self,
        step_runner: StepRunner,
        policy_engine: PolicyEngine | None = None,
    ) -> None:
        self._step_runner = step_runner
        self._policy_engine = policy_engine or PolicyEngine()

    def plan(self, workflow: Workflow) -> ExecutionPlan:
        steps_by_id = self._index_steps(workflow)
        ordered_ids = self._topological_sort(workflow, steps_by_id)
        return ExecutionPlan(steps=tuple(steps_by_id[step_id] for step_id in ordered_ids))

    def run(self, workflow: Workflow, context: RunContext) -> RunResult:
        execution_plan = self.plan(workflow)
        if context.mode in (RunMode.PLAN, RunMode.PREVIEW):
            return self._dry_run_result(execution_plan, context)

        results: list[StepResult] = []
        retry_count = 0
        max_retries = self._max_remediation_retries(workflow, context)
        previous_failure_signature: tuple[str, str, str] | None = None
        next_index = 0
        skipped_runtime_steps: set[str] = set()
        active_context = context
        step_index = {step.id: index for index, step in enumerate(execution_plan.steps)}

        while next_index < len(execution_plan.steps):
            step = execution_plan.steps[next_index]
            next_index += 1
            if step.id in skipped_runtime_steps or self._is_runtime_remediation_step(step):
                continue
            skip_reason = self._work_item_step_skip_reason(step, active_context)
            if skip_reason is not None:
                results.append(
                    StepResult(
                        step_id=step.id,
                        status=StepStatus.SKIPPED,
                        metadata={
                            "reason": skip_reason,
                            "precompleted_work_item": bool(
                                active_context.metadata.get("skip_precompleted_work_item_steps")
                            ),
                        },
                    )
                )
                continue

            policy_decision = self._evaluate_command_policy(step, active_context)
            if policy_decision is not None and not policy_decision.allowed:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error=policy_decision.reason,
                    metadata={"policy_decision": policy_decision.as_metadata()},
                )
                results.append(result)
                return RunResult(
                    run_id=context.run_id,
                    status=RunStatus.BLOCKED,
                    step_results=tuple(results),
                    mode=active_context.mode,
                    failed_step_id=step.id,
                    blocker=policy_decision.reason,
                    retry_count=retry_count,
                    metadata=self._result_metadata(execution_plan, active_context, tuple(results)),
                )

            result = self._step_runner.run(step, active_context)
            result = self._structured_verification_result(step, active_context, result)
            if policy_decision is not None:
                result = replace(
                    result,
                    metadata={
                        **dict(result.metadata),
                        "policy_decision": policy_decision.as_metadata(),
                    },
                )
            results.append(result)

            if result.status == StepStatus.FAILED:
                if self._should_restart_plan_after_failed_step(step, result):
                    loop_target = self._plan_restart_loop_target(execution_plan, step_index)
                    signature = (
                        step.id,
                        result.failure_kind.value if result.failure_kind else "",
                        result.error or "",
                    )
                    repeated_failure = previous_failure_signature == signature
                    if (
                        loop_target is not None
                        and (
                            not repeated_failure
                            or self._allows_repeated_plan_restart(result)
                        )
                        and retry_count < max_retries
                    ):
                        previous_failure_signature = signature
                        retry_count += 1
                        active_context = self._runtime_failure_context(
                            active_context,
                            retry_count=retry_count,
                            failed_step=step,
                            failed_result=result,
                        )
                        next_index = loop_target
                        continue
                remediation = self._remediation_path(execution_plan, step, result)
                if remediation is not None:
                    signature = (
                        step.id,
                        result.failure_kind.value if result.failure_kind else "",
                        result.error or "",
                    )
                    if previous_failure_signature == signature or retry_count >= max_retries:
                        return RunResult(
                            run_id=context.run_id,
                            status=RunStatus.BLOCKED,
                            step_results=tuple(results),
                            mode=context.mode,
                            failed_step_id=step.id,
                            failure_kind=result.failure_kind,
                            blocker=result.error,
                            retry_count=retry_count,
                            metadata=self._result_metadata(
                                execution_plan,
                                context,
                                tuple(results),
                                extra={
                                    "remediation_blocked": True,
                                    "max_remediation_retries": max_retries,
                                    "repeated_failure": previous_failure_signature == signature,
                                },
                            ),
                        )
                    previous_failure_signature = signature
                    retry_count += 1
                    failure_context = self._runtime_failure_context(
                        active_context,
                        retry_count=retry_count,
                        failed_step=step,
                        failed_result=result,
                    )
                    if remediation.decision_step is not None:
                        decision_result = self._run_runtime_step(
                            remediation.decision_step,
                            failure_context,
                            results,
                            retry_count=retry_count,
                            failed_step=step,
                            failed_result=result,
                        )
                        if decision_result.status != StepStatus.SUCCEEDED:
                            return self._blocked_result(
                                execution_plan, active_context, tuple(results), decision_result, retry_count
                            )
                    remediation_result = self._run_runtime_step(
                        remediation.remediation_step,
                        failure_context,
                        results,
                        retry_count=retry_count,
                        failed_step=step,
                        failed_result=result,
                    )
                    if remediation_result.status != StepStatus.SUCCEEDED:
                        return self._blocked_result(
                            execution_plan, active_context, tuple(results), remediation_result, retry_count
                        )
                    active_context = failure_context
                    skipped_runtime_steps.add(remediation.remediation_step.id)
                    next_index = step_index[remediation.loop_target_step.id]
                    continue

                decision_step = self._failure_decision_step(execution_plan, step)
                if decision_step is not None:
                    decision_result = self._run_runtime_step(
                        decision_step,
                        active_context,
                        results,
                        retry_count=retry_count,
                        failed_step=step,
                        failed_result=result,
                    )
                    if decision_result.status != StepStatus.SUCCEEDED:
                        return self._blocked_result(
                            execution_plan, active_context, tuple(results), decision_result, retry_count
                        )
                    return RunResult(
                        run_id=context.run_id,
                        status=RunStatus.BLOCKED,
                        step_results=tuple(results),
                        mode=context.mode,
                        failed_step_id=step.id,
                        failure_kind=result.failure_kind,
                        blocker=result.error,
                        retry_count=retry_count,
                        metadata=self._result_metadata(execution_plan, active_context, tuple(results)),
                    )

                return RunResult(
                    run_id=context.run_id,
                    status=RunStatus.FAILED,
                    step_results=tuple(results),
                    mode=context.mode,
                    failed_step_id=step.id,
                    failure_kind=result.failure_kind,
                    blocker=result.error,
                    retry_count=retry_count,
                    metadata=self._result_metadata(execution_plan, active_context, tuple(results)),
                )

            if result.status == StepStatus.BLOCKED:
                if self._should_restart_plan_after_blocked_step(step, result):
                    loop_target = self._plan_restart_loop_target(execution_plan, step_index)
                    signature = (step.id, result.failure_kind.value, result.error or "")
                    repeated_failure = previous_failure_signature == signature
                    if (
                        loop_target is not None
                        and (
                            not repeated_failure
                            or self._allows_repeated_plan_restart(result)
                        )
                        and retry_count < max_retries
                    ):
                        previous_failure_signature = signature
                        retry_count += 1
                        active_context = self._runtime_failure_context(
                            active_context,
                            retry_count=retry_count,
                            failed_step=step,
                            failed_result=result,
                        )
                        next_index = loop_target
                        continue
                return RunResult(
                    run_id=context.run_id,
                    status=RunStatus.BLOCKED,
                    step_results=tuple(results),
                    mode=active_context.mode,
                    failed_step_id=step.id,
                    failure_kind=result.failure_kind,
                    blocker=result.error,
                    retry_count=retry_count,
                    metadata=self._result_metadata(execution_plan, active_context, tuple(results)),
                )

        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=tuple(results),
            mode=context.mode,
            retry_count=retry_count,
            metadata=self._result_metadata(execution_plan, active_context, tuple(results)),
        )

    def _structured_verification_result(
        self,
        step: Step,
        context: RunContext,
        result: StepResult,
    ) -> StepResult:
        """Prefer the verifier's durable JSON contract over a shell exit code."""

        if step.id != "verify-work-item" or result.status != StepStatus.FAILED:
            return result
        work_item_id = str(context.metadata.get("active_work_item_id") or "")
        if not work_item_id:
            return result
        report_path = (
            context.repo_root
            / ".harness"
            / "runs"
            / context.run_id
            / "work-items"
            / work_item_id
            / "verification"
            / "report.json"
        )
        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return result
        if not isinstance(payload, dict):
            return result
        failure = structured_failure_from_report(payload)
        if failure is None:
            return result
        status = (
            StepStatus.FAILED
            if failure.failure_class
            in {
                VerificationFailureClass.IMPLEMENTATION_FAILURE,
                VerificationFailureClass.SECURITY_REVIEW_FAILURE,
            }
            else StepStatus.BLOCKED
        )
        return replace(
            result,
            status=status,
            error=_verification_failure_error(result, failure),
            failure_kind=_failure_kind_for(failure.failure_class),
            metadata={
                **dict(result.metadata),
                "verification_report_path": str(report_path.relative_to(context.repo_root)),
                "verification_failure": failure.as_dict(),
            },
        )

    def _dry_run_result(self, execution_plan: ExecutionPlan, context: RunContext) -> RunResult:
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
                    metadata=self._result_metadata(execution_plan, context, tuple(step_results)),
                )
            metadata = {
                "mode": context.mode.value,
                "would_run": context.mode == RunMode.PREVIEW,
                "side_effects": False,
            }
            if decision is not None:
                metadata["policy_decision"] = decision.as_metadata()
            step_results.append(StepResult(step_id=step.id, status=StepStatus.SKIPPED, metadata=metadata))
        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=tuple(step_results),
            mode=context.mode,
            metadata=self._result_metadata(execution_plan, context, tuple(step_results)),
        )

    def _result_metadata(
        self,
        execution_plan: ExecutionPlan,
        context: RunContext,
        step_results: tuple[StepResult, ...] = (),
        extra: dict[str, object] | None = None,
    ) -> dict[str, object]:
        policy_decisions = tuple(
            result.metadata["policy_decision"]
            for result in step_results
            if "policy_decision" in result.metadata
        )
        decisions = tuple(
            {"step_id": result.step_id, **dict(result.metadata["decision"])}
            for result in step_results
            if "decision" in result.metadata
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
        metadata: dict[str, object] = {
            "mode": context.mode.value,
            "workflow_name": context.workflow_name,
            "planned_steps": execution_plan.step_ids(),
            "side_effects": context.mode == RunMode.APPLY,
            "policy_decisions": policy_decisions,
            "decisions": decisions,
            "agent_attempts": agent_attempts,
            "phase_metrics": phase_metrics,
        }
        if extra:
            metadata.update(extra)
        return metadata

    def _run_runtime_step(
        self,
        step: Step,
        context: RunContext,
        results: list[StepResult],
        *,
        retry_count: int,
        failed_step: Step,
        failed_result: StepResult,
    ) -> StepResult:
        runtime_context = self._runtime_failure_context(
            context,
            retry_count=retry_count,
            failed_step=failed_step,
            failed_result=failed_result,
        )
        result = self._step_runner.run(step, runtime_context)
        results.append(result)
        return result

    def _runtime_failure_context(
        self,
        context: RunContext,
        *,
        retry_count: int,
        failed_step: Step,
        failed_result: StepResult,
    ) -> RunContext:
        return replace(
            context,
            metadata={
                **dict(context.metadata),
                "runtime_retry_count": retry_count,
                "runtime_failed_step_id": failed_step.id,
                "runtime_failure_kind": failed_result.failure_kind.value if failed_result.failure_kind else "",
                "runtime_failure_error": failed_result.error or "",
                "runtime_failure_metadata": dict(failed_result.metadata),
            },
        )

    def _blocked_result(
        self,
        execution_plan: ExecutionPlan,
        context: RunContext,
        results: tuple[StepResult, ...],
        result: StepResult,
        retry_count: int,
    ) -> RunResult:
        return RunResult(
            run_id=context.run_id,
            status=RunStatus.BLOCKED,
            step_results=results,
            mode=context.mode,
            failed_step_id=result.step_id,
            failure_kind=result.failure_kind,
            blocker=result.error,
            retry_count=retry_count,
            metadata=self._result_metadata(execution_plan, context, results),
        )

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

    def _remediation_path(
        self,
        execution_plan: ExecutionPlan,
        failed_step: Step,
        failed_result: StepResult,
    ) -> _RemediationPath | None:
        if failed_result.failure_kind != FailureKind.IMPLEMENTATION:
            return None
        decision_step = self._failure_decision_step(execution_plan, failed_step)
        steps_by_id = {step.id: step for step in execution_plan.steps}
        if decision_step is not None:
            remediation_steps = tuple(
                step
                for step in execution_plan.steps
                if decision_step.id in step.needs and self._is_runtime_remediation_step(step)
            )
        else:
            remediation_steps = tuple(
                step
                for step in execution_plan.steps
                if failed_step.id in step.needs and self._is_runtime_remediation_step(step)
            )
        if not remediation_steps:
            return None
        remediation_step = remediation_steps[0]
        loop_target_step = steps_by_id.get(str(remediation_step.metadata.get("loop_target", "")))
        if loop_target_step is None:
            return None
        return _RemediationPath(decision_step, remediation_step, loop_target_step)

    def _failure_decision_step(self, execution_plan: ExecutionPlan, failed_step: Step) -> Step | None:
        return next(
            (
                step
                for step in execution_plan.steps
                if failed_step.id in step.needs and step.kind == StepKind.DECISION
            ),
            None,
        )

    def _is_runtime_remediation_step(self, step: Step) -> bool:
        return bool(step.metadata.get("loop_target"))

    def _should_restart_plan_after_blocked_step(
        self,
        step: Step,
        result: StepResult,
    ) -> bool:
        if result.failure_kind == FailureKind.PLAN_REVIEW_REJECTED:
            return step.id == "review-work-item-plan"
        return result.failure_kind == FailureKind.SCOPE_CONFLICT and step.id in {
            "execute-work-item",
            "verify-work-item",
        }

    def _should_restart_plan_after_failed_step(
        self,
        step: Step,
        result: StepResult,
    ) -> bool:
        return result.failure_kind == FailureKind.SCOPE_CONFLICT and step.id == "verify-work-item"

    def _allows_repeated_plan_restart(self, result: StepResult) -> bool:
        return result.failure_kind == FailureKind.PLAN_REVIEW_REJECTED

    def _plan_restart_loop_target(self, execution_plan: ExecutionPlan, step_index: dict[str, int]) -> int | None:
        if "plan-work-item" in step_index:
            return step_index["plan-work-item"]
        for index, step in enumerate(execution_plan.steps):
            if step.agent_id == "implementation_planner":
                return index
        return None

    def _max_remediation_retries(self, workflow: Workflow, context: RunContext) -> int:
        value = (
            context.metadata.get("max_remediation_retries")
            or workflow.metadata.get("max_remediation_retries")
            or next(
                (
                    step.metadata.get("max_retry_count")
                    for step in workflow.steps
                    if self._is_runtime_remediation_step(step)
                    and step.metadata.get("max_retry_count") is not None
                ),
                None,
            )
            or 2
        )
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 2

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

    def _topological_sort(self, workflow: Workflow, steps_by_id: dict[str, Step]) -> tuple[str, ...]:
        dependents_by_step_id: dict[str, list[str]] = {step.id: [] for step in workflow.steps}
        remaining_needs_count: dict[str, int] = {step.id: len(step.needs) for step in workflow.steps}
        for step in workflow.steps:
            for needed_step_id in step.needs:
                dependents_by_step_id[needed_step_id].append(step.id)
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


def _failure_kind_for(failure_class: VerificationFailureClass) -> FailureKind:
    mapping = {
        VerificationFailureClass.IMPLEMENTATION_FAILURE: FailureKind.IMPLEMENTATION,
        VerificationFailureClass.UNCLEAR_E2E_GOAL: FailureKind.UNCLEAR_E2E_GOAL,
        VerificationFailureClass.DOCUMENT_DELTA_CONFLICT: FailureKind.DOCUMENT_DELTA_CONFLICT,
        VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT: FailureKind.UPSTREAM_DESIGN,
        VerificationFailureClass.ENVIRONMENT_BLOCKER: FailureKind.ENVIRONMENT_BLOCKER,
        VerificationFailureClass.SCOPE_CONFLICT: FailureKind.SCOPE_CONFLICT,
        VerificationFailureClass.SECURITY_REVIEW_FAILURE: FailureKind.SECURITY_REVIEW_FAILURE,
        VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR: FailureKind.VERIFICATION_GOAL_UNCLEAR,
    }
    return mapping[failure_class]


def _verification_failure_error(
    result: StepResult,
    failure: VerificationFailure,
) -> str:
    if failure.evidence:
        return "; ".join(failure.evidence)
    return result.error or failure.failure_class.value
