"""Workflow-level progression owned by the orchestrator.

RunnerEngine executes one requested step. This module owns the loop that decides
which step to run next, when to pause, and how to route blocked/failed outcomes.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Mapping

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    RunContext,
    RunResult,
    RunStatus,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.workflow_routing import RouteAction, RouteDecision, WorkflowRoutingPolicy


class WorkflowOrchestrator:
    """Own workflow progression and delegate single-step execution to RunnerEngine."""

    def __init__(
        self,
        *,
        engine: RunnerEngine,
        routing_policy: WorkflowRoutingPolicy | None = None,
        max_transitions: int = 64,
    ) -> None:
        self._engine = engine
        self._routing_policy = routing_policy or WorkflowRoutingPolicy()
        self._max_transitions = max_transitions

    def run(self, workflow: Workflow, context: RunContext) -> RunResult:
        ordered_steps = self._engine.plan(workflow).steps
        step_index = {step.id: index for index, step in enumerate(ordered_steps)}
        if not ordered_steps:
            return self._engine.run_result(
                workflow,
                context,
                (),
                status=RunStatus.SUCCEEDED,
                extra_metadata={"orchestrator_status": "empty_workflow"},
            )

        current_step_id = self._first_progress_step(ordered_steps)
        results: list[StepResult] = []
        completed: set[str] = set()
        retry_count = 0
        transitions = 0
        active_context = context

        while current_step_id is not None:
            transitions += 1
            if transitions > self._max_transitions:
                return self._engine.run_result(
                    workflow,
                    active_context,
                    tuple(results),
                    status=RunStatus.BLOCKED,
                    retry_count=retry_count,
                    blocker="workflow orchestrator transition budget exceeded",
                    extra_metadata={"orchestrator_status": "transition_budget_exceeded"},
                )

            step = workflow.step_by_id(current_step_id)
            if self._is_runtime_control_step(step):
                current_step_id = self._next_progress_step(ordered_steps, step_index, current_step_id)
                continue

            step_context = self._with_orchestrator_state(
                active_context,
                completed_step_ids=tuple(sorted(completed)),
                current_step_id=current_step_id,
                retry_count=retry_count,
            )
            result = self._engine.run_step(
                workflow,
                step_context,
                current_step_id,
                completed_step_ids=tuple(sorted(completed)),
            )
            results.append(result)

            if result.status in {StepStatus.SUCCEEDED, StepStatus.SKIPPED}:
                completed.add(current_step_id)
                current_step_id = self._next_progress_step(ordered_steps, step_index, current_step_id)
                continue

            if result.status in {StepStatus.FAILED, StepStatus.BLOCKED}:
                routed = self._route_blocker(
                    workflow,
                    active_context,
                    results,
                    completed,
                    step,
                    result,
                    retry_count,
                    step_index,
                )
                if isinstance(routed, RunResult):
                    return routed
                active_context, retry_count, current_step_id = routed
                continue

            return self._engine.run_result(
                workflow,
                active_context,
                tuple(results),
                status=RunStatus.BLOCKED,
                retry_count=retry_count,
                failed_step_id=result.step_id,
                failure_kind=result.failure_kind,
                blocker=f"unsupported step status: {result.status.value}",
                extra_metadata={"orchestrator_status": "unsupported_step_status"},
            )

        return self._engine.run_result(
            workflow,
            active_context,
            tuple(results),
            status=RunStatus.SUCCEEDED,
            retry_count=retry_count,
            extra_metadata={"orchestrator_status": "completed"},
        )

    def _route_blocker(
        self,
        workflow: Workflow,
        context: RunContext,
        results: list[StepResult],
        completed: set[str],
        failed_step: Step,
        failed_result: StepResult,
        retry_count: int,
        step_index: dict[str, int],
    ) -> RunResult | tuple[RunContext, int, str]:
        decision = self._routing_policy.decide(failed_result, attempt=retry_count)
        failed_result = self._with_route_decision(failed_result, decision)
        results[-1] = failed_result
        if decision.action is RouteAction.STOP_FATAL:
            return self._engine.run_result(
                workflow,
                context,
                tuple(results),
                status=RunStatus.FAILED,
                retry_count=retry_count,
                failed_step_id=failed_result.step_id,
                failure_kind=failed_result.failure_kind,
                blocker=failed_result.error,
                extra_metadata={"orchestrator_status": "fatal_stop"},
            )

        failure_context = self._failure_context(
            context,
            retry_count=retry_count,
            failed_step=failed_step,
            failed_result=failed_result,
            completed=completed,
        )
        decision_step = self._orchestration_decision_step(failure_context)
        decision_result = self._engine.execute_step(
            decision_step,
            failure_context,
            apply_work_item_skip=False,
        )
        results.append(decision_result)
        if decision_result.status is not StepStatus.SUCCEEDED:
            return self._engine.run_result(
                workflow,
                failure_context,
                tuple(results),
                status=RunStatus.BLOCKED,
                retry_count=retry_count,
                failed_step_id=decision_result.step_id,
                failure_kind=decision_result.failure_kind,
                blocker=decision_result.error,
                extra_metadata={"orchestrator_status": "decision_step_blocked"},
            )

        try:
            payload = self._orchestration_decision_payload(decision_result, failure_context, decision_step)
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
            return self._engine.run_result(
                workflow,
                failure_context,
                tuple(results),
                status=RunStatus.BLOCKED,
                retry_count=retry_count,
                failed_step_id=contract_result.step_id,
                failure_kind=contract_result.failure_kind,
                blocker=contract_result.error,
                extra_metadata={"orchestrator_status": "invalid_decision_contract"},
            )

        if payload is None or payload.get("status") != "route":
            return self._engine.run_result(
                workflow,
                failure_context,
                tuple(results),
                status=RunStatus.BLOCKED,
                retry_count=retry_count,
                failed_step_id=failed_result.step_id,
                failure_kind=failed_result.failure_kind,
                blocker=failed_result.error,
                extra_metadata={
                    "orchestrator_status": "paused",
                    "orchestration_decision": dict(payload or {}),
                },
            )

        target_step_id = str(payload.get("target_step") or "")
        route_error = self._route_error(workflow, target_step_id, failed_step, step_index)
        if route_error is not None:
            return self._engine.run_result(
                workflow,
                failure_context,
                tuple(results),
                status=RunStatus.BLOCKED,
                retry_count=retry_count,
                failed_step_id=failed_result.step_id,
                failure_kind=failed_result.failure_kind,
                blocker=route_error,
                extra_metadata={
                    "orchestrator_status": "route_rejected",
                    "orchestration_route_rejected": route_error,
                    "orchestration_target_step": target_step_id,
                },
            )

        retry_count += 1
        target_step = workflow.step_by_id(target_step_id)
        if self._is_runtime_remediation_step(target_step):
            loop_target_id = str(target_step.metadata.get("loop_target") or "")
            next_context = self._failure_context(
                context,
                retry_count=retry_count,
                failed_step=failed_step,
                failed_result=failed_result,
                completed=completed,
                route_target_step_id=target_step_id,
                resume_boundary_step_id=loop_target_id,
            )
            repair_result = self._engine.run_step(
                workflow,
                next_context,
                target_step_id,
                completed_step_ids=tuple(sorted(completed)),
                enforce_needs=False,
            )
            results.append(repair_result)
            if repair_result.status is not StepStatus.SUCCEEDED:
                return self._engine.run_result(
                    workflow,
                    next_context,
                    tuple(results),
                    status=RunStatus.BLOCKED,
                    retry_count=retry_count,
                    failed_step_id=repair_result.step_id,
                    failure_kind=repair_result.failure_kind,
                    blocker=repair_result.error,
                    extra_metadata={"orchestrator_status": "repair_step_blocked"},
                )
            completed.add(target_step_id)
            return next_context, retry_count, loop_target_id

        next_context = self._failure_context(
            context,
            retry_count=retry_count,
            failed_step=failed_step,
            failed_result=failed_result,
            completed=completed,
            route_target_step_id=target_step_id,
            resume_boundary_step_id=target_step_id,
        )
        return next_context, retry_count, target_step_id

    def _orchestration_decision_step(self, context: RunContext) -> Step:
        output = self._decision_path_template(context)
        return Step(
            id="workflow-orchestrator",
            kind=StepKind.AGENT,
            name="Select next workflow step",
            agent_id="workflow_orchestrator",
            skill_id="harness-workflow-orchestrator",
            outputs=(Path(output),),
            metadata={
                "stage": "orchestration",
                "scope": "workflow",
                "execution_boundary": context.metadata.get("execution_boundary", "workflow"),
                "orchestration_decision_path": output,
                "final_response_contract": {
                    "channel": "final-message",
                    "format": "xml",
                    "output": output,
                    "handoff_type": "orchestration-decision",
                },
            },
        )

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
        candidates.extend(_runtime_path(str(output), context) for output in decision_step.outputs)
        for path in candidates:
            if not path.exists():
                continue
            from harness_codex.runtime.xml_handoff import read_handoff

            payload = read_handoff(path, expected_type="orchestration-decision")
            if isinstance(payload, Mapping):
                return payload
        return None

    def _failure_context(
        self,
        context: RunContext,
        *,
        retry_count: int,
        failed_step: Step,
        failed_result: StepResult,
        completed: set[str],
        route_target_step_id: str = "",
        resume_boundary_step_id: str = "",
    ) -> RunContext:
        metadata = {
            **dict(context.metadata),
            "orchestrator_owner": True,
            "orchestrator_completed_step_ids": tuple(sorted(completed)),
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
                        "workflow_orchestrator selected an upstream repair boundary; "
                        "modify only artifacts needed to resolve the blocker"
                    ),
                }
            )
        return replace(context, metadata=metadata)

    def _with_orchestrator_state(
        self,
        context: RunContext,
        *,
        completed_step_ids: tuple[str, ...],
        current_step_id: str,
        retry_count: int,
    ) -> RunContext:
        return replace(
            context,
            metadata={
                **dict(context.metadata),
                "orchestrator_owner": True,
                "orchestrator_current_step_id": current_step_id,
                "orchestrator_completed_step_ids": completed_step_ids,
                "runtime_retry_count": retry_count,
            },
        )

    def _route_error(
        self,
        workflow: Workflow,
        target_step_id: str,
        failed_step: Step,
        step_index: dict[str, int],
    ) -> str | None:
        if not target_step_id:
            return "orchestration decision did not provide target_step"
        try:
            target_step = workflow.step_by_id(target_step_id)
        except KeyError:
            return f"target step does not exist in workflow graph: {target_step_id}"
        if self._is_runtime_control_step(target_step) and not self._is_runtime_remediation_step(target_step):
            return "orchestrator cannot route to another orchestration control step"
        failed_index = step_index[failed_step.id]
        target_index = step_index[target_step_id]
        if self._is_runtime_remediation_step(target_step):
            loop_target_id = str(target_step.metadata.get("loop_target") or "")
            if loop_target_id not in step_index:
                return f"runtime remediation target has unknown loop_target: {loop_target_id}"
            if step_index[loop_target_id] > failed_index:
                return "runtime remediation loop_target is after the blocked/failed step"
            return None
        if target_index > failed_index:
            return "orchestrator cannot route to a step after the blocked/failed step"
        return None

    def _with_route_decision(self, result: StepResult, decision: RouteDecision) -> StepResult:
        return replace(
            result,
            metadata={
                **dict(result.metadata),
                "route_decision": decision.as_metadata(),
            },
        )

    def _first_progress_step(self, steps: tuple[Step, ...]) -> str | None:
        for step in steps:
            if not self._is_runtime_control_step(step):
                return step.id
        return None

    def _next_progress_step(
        self,
        steps: tuple[Step, ...],
        step_index: dict[str, int],
        current_step_id: str,
    ) -> str | None:
        for step in steps[step_index[current_step_id] + 1 :]:
            if not self._is_runtime_control_step(step):
                return step.id
        return None

    def _is_runtime_control_step(self, step: Step) -> bool:
        return self._is_runtime_remediation_step(step) or bool(step.metadata.get("runtime_handoff_only"))

    def _is_runtime_remediation_step(self, step: Step) -> bool:
        return bool(step.metadata.get("loop_target"))

    def _decision_path_template(self, context: RunContext) -> str:
        work_item_id = str(
            context.metadata.get("active_work_item_id")
            or context.metadata.get("work_item_id")
            or "finalization"
        )
        return (
            f".harness/runs/<RUN-ID>/work-items/{work_item_id}/"
            "orchestration/orchestration-decision.xml"
        )


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
