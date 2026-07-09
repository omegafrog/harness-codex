"""Workflow execution engine.

The engine owns ordering, dependency checks, status aggregation, command-policy
checks, durable step-ledger writes, and failure handoff. Tool execution remains
behind the ``StepRunner`` boundary.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Mapping

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
from harness_codex.runtime.step_transaction_store import StepTransactionStore
from harness_codex.runtime.verification_failure import (
    VerificationFailure,
    VerificationFailureClass,
    structured_failure_from_report,
)
from harness_codex.runtime.workflow_routing import (
    RouteAction,
    RouteDecision,
    WorkflowRoutingPolicy,
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
        progress_emit: Callable[[str], None] | None = None,
        workflow_routing_policy: WorkflowRoutingPolicy | None = None,
    ) -> None:
        self._step_runner = step_runner
        self._policy_engine = policy_engine or PolicyEngine()
        self._progress_emit = progress_emit
        self._workflow_routing_policy = workflow_routing_policy or WorkflowRoutingPolicy()

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
        retry_count = 0
        next_index = 0
        active_context = context
        step_index = {step.id: index for index, step in enumerate(execution_plan.steps)}

        while next_index < len(execution_plan.steps):
            step = execution_plan.steps[next_index]
            next_index += 1
            if self._is_runtime_remediation_step(step) or self._is_runtime_handoff_step(step):
                continue
            skip_reason = self._work_item_step_skip_reason(step, active_context)
            if skip_reason is not None:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.SKIPPED,
                    metadata={
                        "reason": skip_reason,
                        "precompleted_work_item": bool(
                            active_context.metadata.get("skip_precompleted_work_item_steps")
                        ),
                    },
                )
                self._record_terminal_step(step, active_context, result)
                results.append(result)
                self._emit_step_result(step, result)
                continue

            policy_decision = self._evaluate_command_policy(step, active_context)
            if policy_decision is not None and not policy_decision.allowed:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error=policy_decision.reason,
                    metadata={"policy_decision": policy_decision.as_metadata()},
                )
                self._record_terminal_step(step, active_context, result)
                results.append(result)
                self._emit_step_result(step, result)
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

            result = self._run_step(step, active_context)
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
            self._emit_step_result(step, result)

            if result.status == StepStatus.FAILED:
                handoff = self._handoff_to_orchestration(
                    execution_plan,
                    active_context,
                    results,
                    step_index,
                    retry_count,
                    failed_step=step,
                    failed_result=result,
                    fallback_status=RunStatus.FAILED,
                )
                if isinstance(handoff, RunResult):
                    return handoff
                active_context, retry_count, next_index = handoff
                continue

            if result.status == StepStatus.BLOCKED:
                handoff = self._handoff_to_orchestration(
                    execution_plan,
                    active_context,
                    results,
                    step_index,
                    retry_count,
                    failed_step=step,
                    failed_result=result,
                    fallback_status=RunStatus.BLOCKED,
                )
                if isinstance(handoff, RunResult):
                    return handoff
                active_context, retry_count, next_index = handoff
                continue

        return RunResult(
            run_id=context.run_id,
            status=RunStatus.SUCCEEDED,
            step_results=tuple(results),
            mode=context.mode,
            retry_count=retry_count,
            metadata=self._result_metadata(execution_plan, active_context, tuple(results)),
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

    def _structured_verification_result(
        self,
        step: Step,
        context: RunContext,
        result: StepResult,
    ) -> StepResult:
        """Prefer the verifier's durable contract over a shell exit code."""

        if step.id == "verify-work-item-security" and result.status is StepStatus.FAILED:
            work_item_id = str(context.metadata.get("active_work_item_id") or "")
            security_review_path = (
                context.repo_root
                / ".harness"
                / "runs"
                / context.run_id
                / "work-items"
                / work_item_id
                / "security"
                / "security-review.md"
            )
            verdict_path = security_review_path.with_suffix(".xml")
            try:
                from harness_codex.runtime.xml_handoff import read_handoff

                verdict = read_handoff(verdict_path, expected_type="gate-verdict")
            except ValueError as exc:
                return replace(
                    result,
                    status=StepStatus.BLOCKED,
                    error=f"canonical security review XML is missing or invalid: {exc}",
                    failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                    metadata={
                        **dict(result.metadata),
                        "security_review_verdict_path": str(
                            verdict_path.relative_to(context.repo_root)
                        ),
                        "security_review_contract": "missing-or-invalid",
                    },
                )
            if verdict.get("status") != "rejected":
                return replace(
                    result,
                    status=StepStatus.BLOCKED,
                    error="security review command failed without a rejected XML verdict",
                    failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                    metadata={
                        **dict(result.metadata),
                        "security_review_verdict_path": str(
                            verdict_path.relative_to(context.repo_root)
                        ),
                        "security_review_contract": "inconsistent",
                    },
                )
            failure = VerificationFailure(
                failure_class=VerificationFailureClass.SECURITY_REVIEW_FAILURE,
                owner_stage="implementation-planner",
                recommended_resume_target="prepare-plan-repair",
                evidence=(str(verdict_path.relative_to(context.repo_root)),),
            )
            return replace(
                result,
                error=result.error or "security review rejected",
                failure_kind=FailureKind.IMPLEMENTATION,
                metadata={
                    **dict(result.metadata),
                    "runtime_failure_class": failure.failure_class.value,
                    "security_review_path": str(security_review_path.relative_to(context.repo_root)),
                    "security_review_verdict_path": str(verdict_path.relative_to(context.repo_root)),
                    "verification_failure": failure.as_dict(),
                },
            )

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
            / "verification.xml"
        )
        try:
            from harness_codex.runtime.xml_handoff import read_handoff

            payload = read_handoff(report_path, expected_type="verification-report")
        except (ImportError, ValueError):
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
        route_decisions = tuple(
            {"step_id": result.step_id, **dict(result.metadata["route_decision"])}
            for result in step_results
            if "route_decision" in result.metadata
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
            "route_decisions": route_decisions,
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
        result = self._run_step(step, runtime_context)
        results.append(result)
        self._emit_step_result(step, result)
        return result

    def _emit_step_result(self, step: Step, result: StepResult) -> None:
        if self._progress_emit is None:
            return
        detail = result.error or result.metadata.get("reason") or ""
        suffix = f" - {detail}" if detail else ""
        self._progress_emit(f"{step.id}: {result.status.value}{suffix}")

    def _runtime_failure_context(
        self,
        context: RunContext,
        *,
        retry_count: int,
        failed_step: Step,
        failed_result: StepResult,
        route_target_step_id: str = "",
        resume_boundary_step_id: str = "",
    ) -> RunContext:
        metadata = {
            **dict(context.metadata),
            "runtime_retry_count": retry_count,
            "runtime_failed_step_id": failed_step.id,
            "runtime_failure_kind": failed_result.failure_kind.value if failed_result.failure_kind else "",
            "runtime_failure_error": failed_result.error or "",
            "runtime_failure_metadata": dict(failed_result.metadata),
        }
        if route_target_step_id:
            metadata.update(
                {
                    "runtime_route_target_step_id": route_target_step_id,
                    "runtime_resume_boundary_step_id": resume_boundary_step_id or route_target_step_id,
                    "runtime_partial_repair": True,
                    "runtime_partial_repair_reason": (
                        "orchestration routed to an upstream repair boundary; "
                        "modify only artifacts needed to resolve the blocker"
                    ),
                }
            )
        return replace(context, metadata=metadata)

    def _handoff_to_orchestration(
        self,
        execution_plan: ExecutionPlan,
        context: RunContext,
        results: list[StepResult],
        step_index: dict[str, int],
        retry_count: int,
        *,
        failed_step: Step,
        failed_result: StepResult,
        fallback_status: RunStatus,
    ) -> RunResult | tuple[RunContext, int, int]:
        decision = self._workflow_routing_policy.decide(
            failed_result,
            attempt=retry_count,
        )
        failed_result = self._with_route_decision(failed_result, decision)
        results[-1] = failed_result
        if decision.action is RouteAction.STOP_FATAL:
            return self._routed_terminal_result(
                execution_plan,
                context,
                tuple(results),
                failed_result,
                decision,
                retry_count,
                fallback_status=fallback_status,
            )

        decision_step = self._failure_decision_step(execution_plan, failed_step)
        if decision_step is None:
            return self._routed_terminal_result(
                execution_plan,
                context,
                tuple(results),
                failed_result,
                decision,
                retry_count,
                fallback_status=fallback_status,
            )

        decision_result = self._run_runtime_step(
            decision_step,
            context,
            results,
            retry_count=retry_count,
            failed_step=failed_step,
            failed_result=failed_result,
        )
        if decision_result.status != StepStatus.SUCCEEDED:
            return self._blocked_result(
                execution_plan, context, tuple(results), decision_result, retry_count
            )
        try:
            target_step_id = self._orchestration_target_step(decision_result, context, decision_step)
        except ValueError as exc:
            contract_result = replace(
                decision_result,
                status=StepStatus.BLOCKED,
                error=f"invalid orchestration-decision XML: {exc}",
                metadata={
                    **dict(decision_result.metadata),
                    "orchestration_decision_contract": "invalid",
                    "orchestration_decision_error": str(exc),
                },
            )
            results[-1] = contract_result
            return self._blocked_result(
                execution_plan, context, tuple(results), contract_result, retry_count
            )
        if target_step_id is None:
            return self._routed_terminal_result(
                execution_plan,
                context,
                tuple(results),
                failed_result,
                decision,
                retry_count,
                fallback_status=RunStatus.BLOCKED,
                extra={"orchestration_handoff_completed": True},
            )
        target_step = execution_plan.steps[step_index[target_step_id]] if target_step_id in step_index else None
        route_error = self._orchestration_route_error(
            target_step_id,
            target_step,
            failed_step,
            execution_plan,
            step_index,
        )
        if route_error is not None:
            return self._routed_terminal_result(
                execution_plan,
                context,
                tuple(results),
                failed_result,
                decision,
                retry_count,
                fallback_status=RunStatus.BLOCKED,
                extra={
                    "orchestration_handoff_completed": True,
                    "orchestration_route_rejected": route_error,
                    "orchestration_target_step": target_step_id,
                },
            )

        retry_count += 1
        assert target_step is not None
        if self._is_runtime_remediation_step(target_step):
            loop_target_id = str(target_step.metadata.get("loop_target") or "")
            loop_target_index = step_index[loop_target_id]
            next_context = self._runtime_failure_context(
                context,
                retry_count=retry_count,
                failed_step=failed_step,
                failed_result=failed_result,
                route_target_step_id=target_step_id,
                resume_boundary_step_id=loop_target_id,
            )
            remediation_result = self._run_runtime_step(
                target_step,
                next_context,
                results,
                retry_count=retry_count,
                failed_step=failed_step,
                failed_result=failed_result,
            )
            if remediation_result.status != StepStatus.SUCCEEDED:
                return self._blocked_result(
                    execution_plan, next_context, tuple(results), remediation_result, retry_count
                )
            return next_context, retry_count, loop_target_index

        next_context = self._runtime_failure_context(
            context,
            retry_count=retry_count,
            failed_step=failed_step,
            failed_result=failed_result,
            route_target_step_id=target_step_id,
            resume_boundary_step_id=target_step_id,
        )
        return next_context, retry_count, step_index[target_step_id]

    def _with_route_decision(
        self,
        result: StepResult,
        decision: RouteDecision,
    ) -> StepResult:
        return replace(
            result,
            metadata={
                **dict(result.metadata),
                "route_decision": decision.as_metadata(),
            },
        )

    def _orchestration_target_step(
        self,
        result: StepResult,
        context: RunContext,
        decision_step: Step,
    ) -> str | None:
        for key in ("target_step", "route_target", "next_step"):
            value = result.metadata.get(key)
            if isinstance(value, str) and value:
                return value
        decision = result.metadata.get("decision")
        if isinstance(decision, dict):
            for key in ("target_step", "route_target", "next_step"):
                value = decision.get(key)
                if isinstance(value, str) and value:
                    return value
        payload = self._orchestration_decision_payload(result, context, decision_step)
        if payload is None or payload.get("status") != "route":
            return None
        target_step = payload.get("target_step")
        return target_step if isinstance(target_step, str) and target_step else None

    def _orchestration_decision_payload(
        self,
        result: StepResult,
        context: RunContext,
        decision_step: Step,
    ) -> Mapping[str, object] | None:
        candidates: list[Path] = []
        for value in (
            result.metadata.get("orchestration_decision_path"),
            decision_step.metadata.get("orchestration_decision_path"),
        ):
            if isinstance(value, str) and value:
                candidates.append(_runtime_path(value, context))
        candidates.extend(context.repo_root / output for output in decision_step.outputs)
        for path in candidates:
            if not path.exists():
                continue
            try:
                from harness_codex.runtime.xml_handoff import read_handoff

                payload = read_handoff(path, expected_type="orchestration-decision")
            except ImportError:
                continue
            if isinstance(payload, Mapping):
                return payload
        return None

    def _orchestration_route_error(
        self,
        target_step_id: str,
        target_step: Step | None,
        failed_step: Step,
        execution_plan: ExecutionPlan,
        step_index: dict[str, int],
    ) -> str | None:
        if target_step is None:
            return f"target step does not exist in workflow graph: {target_step_id}"
        if self._is_runtime_handoff_step(target_step):
            return "orchestration cannot route to another runtime handoff step"
        failed_index = step_index[failed_step.id]
        target_index = step_index[target_step_id]
        if self._is_runtime_remediation_step(target_step):
            loop_target_id = str(target_step.metadata.get("loop_target") or "")
            if loop_target_id not in step_index:
                return f"runtime remediation target has unknown loop_target: {loop_target_id}"
            if step_index[loop_target_id] > failed_index:
                return "runtime remediation loop_target is after the blocked step"
            return None
        if target_index > failed_index:
            return "orchestration cannot route to a step after the blocked/failed step"
        if target_step_id == failed_step.id:
            return None
        return None

    def _routed_terminal_result(
        self,
        execution_plan: ExecutionPlan,
        context: RunContext,
        results: tuple[StepResult, ...],
        result: StepResult,
        decision: RouteDecision,
        retry_count: int,
        *,
        fallback_status: RunStatus,
        extra: dict[str, object] | None = None,
    ) -> RunResult:
        status = fallback_status
        metadata_extra = dict(extra or {})
        if decision.action is RouteAction.STOP_FATAL:
            status = RunStatus.FAILED
        elif decision.action is RouteAction.HANDOFF:
            status = RunStatus.BLOCKED
            metadata_extra.setdefault("orchestration_handoff_required", True)
        return RunResult(
            run_id=context.run_id,
            status=status,
            step_results=results,
            mode=context.mode,
            failed_step_id=result.step_id,
            failure_kind=result.failure_kind,
            blocker=result.error,
            retry_count=retry_count,
            metadata=self._result_metadata(execution_plan, context, results, extra=metadata_extra),
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
        decision_step = self._failure_decision_step(
            execution_plan,
            failed_step,
            include_runtime_handoff=False,
        )
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

    def _failure_decision_step(
        self,
        execution_plan: ExecutionPlan,
        failed_step: Step,
        *,
        include_runtime_handoff: bool = True,
    ) -> Step | None:
        return next(
            (
                step
                for step in execution_plan.steps
                if failed_step.id in step.needs
                and (
                    step.kind == StepKind.DECISION
                    or (include_runtime_handoff and self._is_runtime_handoff_step(step))
                )
            ),
            None,
        )

    def _is_runtime_remediation_step(self, step: Step) -> bool:
        return bool(step.metadata.get("loop_target"))

    def _is_runtime_handoff_step(self, step: Step) -> bool:
        return bool(step.metadata.get("runtime_handoff_only")) and step.kind in {
            StepKind.AGENT,
            StepKind.DECISION,
        }

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
        return False

    def _plan_restart_loop_target(self, execution_plan: ExecutionPlan, step_index: dict[str, int]) -> int | None:
        if "plan-work-item" in step_index:
            return step_index["plan-work-item"]
        for index, step in enumerate(execution_plan.steps):
            if step.agent_id == "implementation_planner":
                return index
        return None

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


def _runtime_path(value: str, context: RunContext) -> Path:
    replacements = {
        "<RUN-ID>": context.run_id,
        "<WORK-ITEM-ID>": str(context.metadata.get("active_work_item_id") or ""),
        "<UC-ID>": str(
            context.metadata.get("uc_id")
            or context.metadata.get("target_uc")
            or context.metadata.get("active_work_item_id")
            or ""
        ),
        "<MAINT-ID>": str(context.metadata.get("active_work_item_id") or ""),
        "<CHG-ID>": str(context.metadata.get("change_set_id") or ""),
    }
    replaced = value
    for placeholder, actual in replacements.items():
        replaced = replaced.replace(placeholder, actual)
    path = Path(replaced)
    return path if path.is_absolute() else context.repo_root / path


def _failure_kind_for(failure_class: VerificationFailureClass) -> FailureKind:
    mapping = {
        VerificationFailureClass.IMPLEMENTATION_FAILURE: FailureKind.IMPLEMENTATION,
        VerificationFailureClass.UNCLEAR_E2E_GOAL: FailureKind.UNCLEAR_E2E_GOAL,
        VerificationFailureClass.DOCUMENT_DELTA_CONFLICT: FailureKind.DOCUMENT_DELTA_CONFLICT,
        VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT: FailureKind.UPSTREAM_DESIGN,
        VerificationFailureClass.ENVIRONMENT_BLOCKER: FailureKind.ENVIRONMENT_BLOCKER,
        VerificationFailureClass.SCOPE_CONFLICT: FailureKind.SCOPE_CONFLICT,
        # A rejected security review can be routed by orchestration to the same
        # repair/replan boundary as a regular implementation defect.
        VerificationFailureClass.SECURITY_REVIEW_FAILURE: FailureKind.IMPLEMENTATION,
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
