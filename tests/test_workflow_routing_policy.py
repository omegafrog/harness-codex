from __future__ import annotations

from harness_codex.runtime.models import FailureKind, StepResult, StepStatus
from harness_codex.runtime.workflow_routing import (
    BlockCode,
    RouteAction,
    WorkflowOutcome,
    WorkflowRoutingPolicy,
)


def test_passed_step_routes_to_next() -> None:
    result = StepResult(step_id="verify", status=StepStatus.SUCCEEDED)

    decision = WorkflowRoutingPolicy().decide(result)

    assert decision.action is RouteAction.NEXT
    assert decision.outcome is WorkflowOutcome.PASSED
    assert decision.target_step is None


def test_maintenance_test_failure_routes_back_to_implementation() -> None:
    result = StepResult(
        step_id="verify-maintenance-result",
        status=StepStatus.FAILED,
        error="tests failed",
        metadata={"block_code": BlockCode.TEST_FAILED.value},
    )

    decision = WorkflowRoutingPolicy().decide(result, workflow_kind="maintenance")

    assert decision.action is RouteAction.ROUTE
    assert decision.outcome is WorkflowOutcome.FAILED
    assert decision.block_code is BlockCode.TEST_FAILED
    assert decision.target_step == "implement-maintenance"


def test_feature_implementation_failure_routes_to_work_item_implementation() -> None:
    result = StepResult(
        step_id="verify-work-item",
        status=StepStatus.FAILED,
        error="implementation defect",
        failure_kind=FailureKind.IMPLEMENTATION,
    )

    decision = WorkflowRoutingPolicy().decide(result, workflow_kind="feature")

    assert decision.action is RouteAction.ROUTE
    assert decision.block_code is BlockCode.IMPLEMENTATION_FAILED
    assert decision.target_step == "implement-work-item"


def test_retry_budget_exceeded_becomes_fatal_stop() -> None:
    result = StepResult(
        step_id="verify-work-item",
        status=StepStatus.FAILED,
        error="same failure repeated",
        metadata={"block_code": BlockCode.TEST_FAILED.value},
    )

    decision = WorkflowRoutingPolicy(retry_budget=2).decide(
        result,
        workflow_kind="feature",
        attempt=2,
    )

    assert decision.action is RouteAction.STOP_FATAL
    assert decision.outcome is WorkflowOutcome.FATAL
    assert decision.block_code is BlockCode.TEST_FAILED
    assert "same failure repeated" in decision.reason


def test_user_decision_required_pauses_instead_of_looping() -> None:
    result = StepResult(
        step_id="promote-design-delta",
        status=StepStatus.BLOCKED,
        error="canonical design conflict requires a product decision",
        metadata={"block_code": BlockCode.USER_DECISION_REQUIRED.value},
    )

    decision = WorkflowRoutingPolicy().decide(result)

    assert decision.action is RouteAction.PAUSE
    assert decision.outcome is WorkflowOutcome.BLOCKED
    assert decision.block_code is BlockCode.USER_DECISION_REQUIRED
    assert decision.terminal


def test_explicit_fatal_metadata_stops_immediately() -> None:
    result = StepResult(
        step_id="classify-diff",
        status=StepStatus.BLOCKED,
        error="unrelated dirty working tree is unsafe to modify",
        metadata={
            "block_code": BlockCode.REPO_DIRTY_UNRELATED.value,
            "unsafe_to_retry": True,
        },
    )

    decision = WorkflowRoutingPolicy().decide(result)

    assert decision.action is RouteAction.STOP_FATAL
    assert decision.outcome is WorkflowOutcome.FATAL
    assert decision.block_code is BlockCode.REPO_DIRTY_UNRELATED
