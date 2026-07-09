"""Loop-capable workflow routing policy primitives.

This module keeps block/failure routing outside individual workflow steps. Steps
return structured results; the orchestrator applies a routing policy to decide
whether the run advances, loops to a repair step, pauses for a user decision, or
stops as fatal.

The policy is intentionally a primitive. It does not monkey-patch the runner and
it does not treat context hints/read-frontier data as a gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Mapping

from harness_codex.runtime.models import FailureKind, StepResult, StepStatus


class WorkflowOutcome(str, Enum):
    """Normalized outcome used by the orchestrator loop."""

    PASSED = "passed"
    BLOCKED = "blocked"
    FAILED = "failed"
    FATAL = "fatal"


class BlockCode(str, Enum):
    """Recoverable and fatal block classes understood by the orchestrator."""

    MISSING_INTENT = "MISSING_INTENT"
    IMPLEMENTATION_FAILED = "IMPLEMENTATION_FAILED"
    TEST_FAILED = "TEST_FAILED"
    TEST_GATE_UNCLEAR = "TEST_GATE_UNCLEAR"
    DESIGN_DELTA_REQUIRED = "DESIGN_DELTA_REQUIRED"
    DESIGN_DELTA_CONFLICT = "DESIGN_DELTA_CONFLICT"
    PROMOTION_CONFLICT = "PROMOTION_CONFLICT"
    STATE_SCHEMA_INVALID = "STATE_SCHEMA_INVALID"
    REPO_DIRTY_UNRELATED = "REPO_DIRTY_UNRELATED"
    USER_DECISION_REQUIRED = "USER_DECISION_REQUIRED"
    ENVIRONMENT_BLOCKER = "ENVIRONMENT_BLOCKER"
    UNKNOWN = "UNKNOWN"


class RouteAction(str, Enum):
    """Action selected by the orchestrator after classifying a step result."""

    NEXT = "next"
    ROUTE = "route"
    PAUSE = "pause"
    STOP_FATAL = "stop_fatal"


@dataclass(frozen=True)
class RouteDecision:
    """Decision recorded by the orchestrator for one step result."""

    action: RouteAction
    outcome: WorkflowOutcome
    from_step: str
    target_step: str | None = None
    block_code: BlockCode | None = None
    reason: str = ""
    attempt: int = 0
    retry_budget: int = 0

    @property
    def terminal(self) -> bool:
        return self.action in {RouteAction.PAUSE, RouteAction.STOP_FATAL}

    def as_metadata(self) -> dict[str, object]:
        return {
            "action": self.action.value,
            "outcome": self.outcome.value,
            "from_step": self.from_step,
            "target_step": self.target_step,
            "block_code": self.block_code.value if self.block_code else None,
            "reason": self.reason,
            "attempt": self.attempt,
            "retry_budget": self.retry_budget,
        }


@dataclass(frozen=True)
class WorkflowRoutingPolicy:
    """Route blocked/failed step results back into a loop-capable workflow graph."""

    retry_budget: int = 3
    default_feature_implementation_step: str = "execute-work-item"
    default_maintenance_implementation_step: str = "execute-work-item"

    def decide(
        self,
        result: StepResult,
        *,
        workflow_kind: str = "feature",
        attempt: int = 0,
        routes: Mapping[BlockCode, str] | None = None,
    ) -> RouteDecision:
        """Return the orchestrator route decision for a step result.

        ``attempt`` is the number of previous attempts for the selected route
        target. Once it reaches ``retry_budget``, recoverable blocks become fatal
        stops so workflows cannot spin forever.
        """

        outcome = _outcome_for(result)
        if outcome is WorkflowOutcome.PASSED:
            return RouteDecision(
                action=RouteAction.NEXT,
                outcome=outcome,
                from_step=result.step_id,
                reason="step passed",
                attempt=attempt,
                retry_budget=self.retry_budget,
            )

        block_code = _block_code_for(result)
        if _result_requests_fatal_stop(result):
            return self._fatal(result, block_code, outcome, attempt, "step requested fatal stop")
        if block_code is BlockCode.USER_DECISION_REQUIRED:
            return RouteDecision(
                action=RouteAction.PAUSE,
                outcome=outcome,
                from_step=result.step_id,
                block_code=block_code,
                reason=result.error or "user decision required",
                attempt=attempt,
                retry_budget=self.retry_budget,
            )
        if attempt >= self.retry_budget:
            return self._fatal(
                result,
                block_code,
                outcome,
                attempt,
                f"retry budget exceeded for {block_code.value}",
            )

        target = self._route_target(block_code, workflow_kind=workflow_kind, routes=routes)
        if target is None:
            return self._fatal(result, block_code, outcome, attempt, "no route target for block")
        return RouteDecision(
            action=RouteAction.ROUTE,
            outcome=outcome,
            from_step=result.step_id,
            target_step=target,
            block_code=block_code,
            reason=result.error or f"route {block_code.value} to {target}",
            attempt=attempt,
            retry_budget=self.retry_budget,
        )

    def _route_target(
        self,
        block_code: BlockCode,
        *,
        workflow_kind: str,
        routes: Mapping[BlockCode, str] | None,
    ) -> str | None:
        if routes and block_code in routes:
            return routes[block_code]
        implementation_step = (
            self.default_maintenance_implementation_step
            if workflow_kind == "maintenance"
            else self.default_feature_implementation_step
        )
        defaults: dict[BlockCode, str] = {
            BlockCode.MISSING_INTENT: "define-maintenance-intent",
            BlockCode.IMPLEMENTATION_FAILED: implementation_step,
            BlockCode.TEST_FAILED: implementation_step,
            BlockCode.TEST_GATE_UNCLEAR: "define-test-gate",
            BlockCode.DESIGN_DELTA_REQUIRED: "create-design-delta",
            BlockCode.DESIGN_DELTA_CONFLICT: "resolve-design-delta-conflict",
            BlockCode.PROMOTION_CONFLICT: "resolve-promotion-conflict",
            BlockCode.STATE_SCHEMA_INVALID: "repair-state",
            BlockCode.REPO_DIRTY_UNRELATED: "classify-diff",
            BlockCode.ENVIRONMENT_BLOCKER: "record-environment-blocker",
        }
        return defaults.get(block_code)

    def _fatal(
        self,
        result: StepResult,
        block_code: BlockCode,
        outcome: WorkflowOutcome,
        attempt: int,
        reason: str,
    ) -> RouteDecision:
        return RouteDecision(
            action=RouteAction.STOP_FATAL,
            outcome=WorkflowOutcome.FATAL if outcome is not WorkflowOutcome.PASSED else outcome,
            from_step=result.step_id,
            block_code=block_code,
            reason=result.error or reason,
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


def _block_code_for(result: StepResult) -> BlockCode:
    raw_code = result.metadata.get("block_code") or result.metadata.get("route_code")
    if isinstance(raw_code, BlockCode):
        return raw_code
    if raw_code:
        try:
            return BlockCode(str(raw_code))
        except ValueError:
            return BlockCode.UNKNOWN
    mapping = {
        FailureKind.IMPLEMENTATION: BlockCode.IMPLEMENTATION_FAILED,
        FailureKind.SCOPE_CONFLICT: BlockCode.DESIGN_DELTA_CONFLICT,
        FailureKind.PLAN_REVIEW_REJECTED: BlockCode.IMPLEMENTATION_FAILED,
        FailureKind.VERIFICATION_GOAL_UNCLEAR: BlockCode.TEST_GATE_UNCLEAR,
        FailureKind.UNCLEAR_E2E_GOAL: BlockCode.TEST_GATE_UNCLEAR,
        FailureKind.DOCUMENT_DELTA_CONFLICT: BlockCode.DESIGN_DELTA_CONFLICT,
        FailureKind.UPSTREAM_DESIGN: BlockCode.DESIGN_DELTA_CONFLICT,
        FailureKind.ENVIRONMENT_BLOCKER: BlockCode.ENVIRONMENT_BLOCKER,
    }
    if result.failure_kind in mapping:
        return mapping[result.failure_kind]
    return BlockCode.UNKNOWN


def _result_requests_fatal_stop(result: StepResult) -> bool:
    return bool(
        result.metadata.get("fatal")
        or result.metadata.get("fatal_stop")
        or result.metadata.get("unsafe_to_retry")
    )
