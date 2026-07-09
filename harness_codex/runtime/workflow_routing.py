"""Loop-capable workflow routing policy primitives.

Runtime routing should not hard-code every project-specific blocking reason.
Steps return structured results; the engine records the failure and hands
unresolved blocked/failed outcomes to an orchestration decision step. That
orchestration step can inspect state/artifacts and choose the next workflow step.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from harness_codex.runtime.models import StepResult, StepStatus


class WorkflowOutcome(str, Enum):
    """Normalized outcome used by the orchestrator loop."""

    PASSED = "passed"
    BLOCKED = "blocked"
    FAILED = "failed"
    FATAL = "fatal"


class RouteAction(str, Enum):
    """Action selected by the engine before orchestration handoff."""

    NEXT = "next"
    HANDOFF = "handoff"
    STOP_FATAL = "stop_fatal"


@dataclass(frozen=True)
class RouteDecision:
    """Decision recorded by the engine for one step result."""

    action: RouteAction
    outcome: WorkflowOutcome
    from_step: str
    reason: str = ""
    route_code: str = ""
    failure_kind: str = ""
    attempt: int = 0
    retry_budget: int = 0

    @property
    def terminal(self) -> bool:
        return self.action is RouteAction.STOP_FATAL

    def as_metadata(self) -> dict[str, object]:
        return {
            "action": self.action.value,
            "outcome": self.outcome.value,
            "from_step": self.from_step,
            "reason": self.reason,
            "route_code": self.route_code,
            "failure_kind": self.failure_kind,
            "attempt": self.attempt,
            "retry_budget": self.retry_budget,
        }


@dataclass(frozen=True)
class WorkflowRoutingPolicy:
    """Decide whether to continue, stop, or hand off to orchestration."""

    retry_budget: int = 3

    def decide(
        self,
        result: StepResult,
        *,
        attempt: int = 0,
    ) -> RouteDecision:
        """Return the engine-level action for a step result.

        Project-specific route selection is deliberately not done here. Unknown
        block reasons remain valid and are handed to the orchestration step.
        """

        outcome = _outcome_for(result)
        route_code = _route_code_for(result)
        failure_kind = result.failure_kind.value if result.failure_kind else ""
        if outcome is WorkflowOutcome.PASSED:
            return RouteDecision(
                action=RouteAction.NEXT,
                outcome=outcome,
                from_step=result.step_id,
                reason="step passed",
                route_code=route_code,
                failure_kind=failure_kind,
                attempt=attempt,
                retry_budget=self.retry_budget,
            )
        if _result_requests_fatal_stop(result) or attempt >= self.retry_budget:
            return RouteDecision(
                action=RouteAction.STOP_FATAL,
                outcome=WorkflowOutcome.FATAL,
                from_step=result.step_id,
                reason=result.error or "workflow routing stopped",
                route_code=route_code,
                failure_kind=failure_kind,
                attempt=attempt,
                retry_budget=self.retry_budget,
            )
        return RouteDecision(
            action=RouteAction.HANDOFF,
            outcome=outcome,
            from_step=result.step_id,
            reason=result.error or "orchestration decision required",
            route_code=route_code,
            failure_kind=failure_kind,
            attempt=attempt,
            retry_budget=self.retry_budget,
        )


def _outcome_for(result: StepResult) -> WorkflowOutcome:
    if result.status in {StepStatus.SUCCEEDED, StepStatus.SKIPPED}:
        return WorkflowOutcome.PASSED
    if result.status is StepStatus.BLOCKED:
        return WorkflowOutcome.BLOCKED
    if result.status is StepStatus.FAILED:
        return WorkflowOutcome.FAILED
    return WorkflowOutcome.BLOCKED


def _route_code_for(result: StepResult) -> str:
    raw_code = result.metadata.get("route_code") or result.metadata.get("block_code") or ""
    return str(raw_code)


def _result_requests_fatal_stop(result: StepResult) -> bool:
    return bool(
        result.metadata.get("fatal")
        or result.metadata.get("fatal_stop")
        or result.metadata.get("unsafe_to_retry")
    )
