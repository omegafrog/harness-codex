"""Single-step execution engine for harness workflows.

Workflow progression is owned by ``WorkflowOrchestrator``. This engine validates
workflow shape, executes one requested step, records step ledger entries, applies
command policy, and normalizes structured step results.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, replace
from pathlib import Path
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
from harness_codex.runtime.policy import CommandRequest, PolicyDecision, PolicyEngine
from harness_codex.runtime.runner import StepRunner
from harness_codex.runtime.step_transaction_store import StepTransactionStore
from harness_codex.runtime.verification_failure import (
    VerificationFailure,
    VerificationFailureClass,
    structured_failure_from_report,
)


class WorkflowValidationError(ValueError):
    """Raised when a workflow graph cannot be executed safely."""


@dataclass(frozen=True)
class ExecutionPlan:
    """Validated workflow step catalog for the orchestrator.

    The plan is not an engine-owned execution loop. It is a safe catalog that
    WorkflowOrchestrator can inspect when choosing one step at a time.
    """

    steps: tuple[Step, ...]

    def step_ids(self) -> tuple[str, ...]:
        return tuple(step.id for step in self.steps)


class RunnerEngine:
    """Execute one orchestrator-selected step through the side-effect boundary."""

    def __init__(
        self,
        step_runner: StepRunner,
        policy_engine: PolicyEngine | None = None,
        progress_emit: Callable[[str], None] | None = None,
        workflow_routing_policy: object | None = None,
    ) -> None:
        self._step_runner = step_runner
        self._policy_engine = policy_engine or PolicyEngine()
        self._progress_emit = progress_emit
        # Kept for constructor compatibility. Workflow routing is now owned by
        # WorkflowOrchestrator, not RunnerEngine.
        self._workflow_routing_policy = workflow_routing_policy

    def set_progress_emit(self, progress_emit: Callable[[str], None] | None) -> None:
        self._progress_emit = progress_emit

    def plan(self, workflow: Workflow) -> ExecutionPlan:
        """Validate a workflow and return a safe step catalog for the orchestrator."""

        steps_by_id = self._index_steps(workflow)
        ordered_ids = self._topological_sort(workflow, steps_by_id)
        return ExecutionPlan(steps=tuple(steps_by_id[step_id] for step_id in ordered_ids))

    def run(self, workflow: Workflow, context: RunContext) -> RunResult:
        """Compatibility wrapper that delegates whole-workflow progress.

        The engine no longer owns workflow progression. Existing callers that
        still call ``RunnerEngine.run`` are forwarded to ``WorkflowOrchestrator``.
        New code should construct the orchestrator directly and use this engine
        only through ``run_step`` / ``execute_step``.
        """

        from harness_codex.runtime.workflow_orchestrator import WorkflowOrchestrator

        return WorkflowOrchestrator(engine=self).run(workflow, context)

    def run_step(
        self,
        workflow: Workflow,
        context: RunContext,
        step_id: str,
        *,
        completed_step_ids: tuple[str, ...] = (),
        enforce_needs: bool = True,
    ) -> StepResult:
        """Execute one workflow step selected by the orchestrator."""

        steps = self.plan(workflow).steps
        steps_by_id = {step.id: step for step in steps}
        step = steps_by_id.get(step_id)
        if step is None:
            result = StepResult(
                step_id=step_id,
                status=StepStatus.BLOCKED,
                error=f"orchestrator selected unknown workflow step: {step_id}",
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
            )
            self._emit_step_result(Step(id=step_id, kind=StepKind.RECORD, name=step_id), result)
            return result

        if enforce_needs:
            completed = set(completed_step_ids)
            missing = tuple(needed for needed in step.needs if needed not in completed)
            if missing:
                result = StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error="step prerequisites are not satisfied: " + ", ".join(missing),
                    failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                    metadata={"missing_needs": missing},
                )
                self._record_terminal_step(step, context, result)
                self._emit_step_result(step, result)
                return result

        return self.execute_step(step, context)

    def execute_step(
        self,
        step: Step,
        context: RunContext,
        *,
        apply_work_item_skip: bool = True,
    ) -> StepResult:
        """Execute one concrete step object without choosing the next step."""

        if context.mode in (RunMode.PLAN, RunMode.PREVIEW):
            result = StepResult(
                step_id=step.id,
                status=StepStatus.SKIPPED,
                metadata={
                    "mode": context.mode.value,
                    "would_run": context.mode == RunMode.PREVIEW,
                    "side_effects": False,
                },
            )
            self._emit_step_result(step, result)
            return result

        if apply_work_item_skip:
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
                self._emit_step_result(step, result)
                return result

        policy_decision = self._evaluate_command_policy(step, context)
        if policy_decision is not None and not policy_decision.allowed:
            result = StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error=policy_decision.reason,
                metadata={"policy_decision": policy_decision.as_metadata()},
            )
            self._record_terminal_step(step, context, result)
            self._emit_step_result(step, result)
            return result

        result = self._run_step(step, context)
        result = self._structured_verification_result(step, context, result)
        if policy_decision is not None:
            result = replace(
                result,
                metadata={
                    **dict(result.metadata),
                    "policy_decision": policy_decision.as_metadata(),
                },
            )
        self._emit_step_result(step, result)
        return result

    def run_result(
        self,
        workflow: Workflow,
        context: RunContext,
        results: tuple[StepResult, ...],
        *,
        status: RunStatus,
        retry_count: int = 0,
        failed_step_id: str | None = None,
        failure_kind: FailureKind | None = None,
        blocker: str | None = None,
        extra_metadata: dict[str, object] | None = None,
    ) -> RunResult:
        """Build a run result for the orchestrator without selecting a step."""

        return RunResult(
            run_id=context.run_id,
            status=status,
            step_results=results,
            mode=context.mode,
            failed_step_id=failed_step_id,
            failure_kind=failure_kind,
            blocker=blocker,
            retry_count=retry_count,
            metadata=self._result_metadata(workflow, context, results, extra=extra_metadata),
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

    def _emit_step_result(self, step: Step, result: StepResult) -> None:
        if self._progress_emit is None:
            return
        detail = result.error or result.metadata.get("reason") or ""
        suffix = f" - {detail}" if detail else ""
        self._progress_emit(f"{step.id}: {result.status.value}{suffix}")

    def _result_metadata(
        self,
        workflow: Workflow,
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
            "planned_steps": workflow.step_ids(),
            "side_effects": context.mode == RunMode.APPLY,
            "policy_decisions": policy_decisions,
            "route_decisions": route_decisions,
            "decisions": decisions,
            "agent_attempts": agent_attempts,
            "phase_metrics": phase_metrics,
            "progress_owner": "workflow_orchestrator",
            "engine_role": "single_step_execution",
        }
        if extra:
            metadata.update(extra)
        return metadata

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
