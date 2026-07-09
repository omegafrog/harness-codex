"""Install loop-capable routing metadata on terminal workflow results."""

from __future__ import annotations

from dataclasses import replace

from harness_codex.runtime.models import RunStatus, StepResult
from harness_codex.runtime.workflow_routing import RouteAction, WorkflowRoutingPolicy


def apply_workflow_routing_patch() -> None:
    """Attach orchestrator route decisions to terminal engine results.

    The existing engine already contains several remediation loops. This patch does
    not replace that behavior. It normalizes any remaining terminal blocked/failed
    result into a route decision so the higher-level orchestrator can either loop
    to an appropriate step, pause for a user decision, or stop as fatal.
    """

    import harness_codex.runtime.engine as engine_module

    RunnerEngine = engine_module.RunnerEngine
    if getattr(RunnerEngine, "_workflow_routing_patch_applied", False):
        return

    original_run = RunnerEngine.run

    def loop_capable_workflow_run(self, workflow, context):
        result = original_run(self, workflow, context)
        if result.status not in {RunStatus.BLOCKED, RunStatus.FAILED}:
            return result
        failed_step_result = _failed_step_result(result.step_results, result.failed_step_id)
        if failed_step_result is None:
            return result

        workflow_kind = str(context.metadata.get("workflow_kind") or workflow.metadata.get("workflow_kind") or "feature")
        policy = getattr(self, "_workflow_routing_policy", None)
        if policy is None:
            policy = WorkflowRoutingPolicy()
            self._workflow_routing_policy = policy
        decision = policy.decide(
            failed_step_result,
            workflow_kind=workflow_kind,
            attempt=result.retry_count,
        )
        metadata = {
            **dict(result.metadata),
            "workflow_loop_capable": True,
            "orchestrator_route_decision": decision.as_metadata(),
        }
        if decision.action is RouteAction.ROUTE:
            # A routeable failed result is no longer a terminal failure for the
            # orchestrator; it is a blocked run with an explicit resume target.
            return replace(result, status=RunStatus.BLOCKED, metadata=metadata)
        if decision.action is RouteAction.STOP_FATAL:
            return replace(
                result,
                status=RunStatus.FAILED,
                blocker=result.blocker or decision.reason,
                metadata={**metadata, "fatal_stop": True},
            )
        return replace(result, metadata=metadata)

    RunnerEngine.run = loop_capable_workflow_run
    RunnerEngine._workflow_routing_patch_applied = True


def _failed_step_result(step_results: tuple[StepResult, ...], failed_step_id: str | None) -> StepResult | None:
    if failed_step_id:
        for result in reversed(step_results):
            if result.step_id == failed_step_id:
                return result
    for result in reversed(step_results):
        if result.status.value in {"blocked", "failed"}:
            return result
    return None
