from __future__ import annotations

from harness_codex.runtime.models import FailureKind, StepResult, StepStatus
from harness_codex.runtime.workflow_routing import (
    RouteAction,
    WorkflowOutcome,
    WorkflowRoutingPolicy,
)


def test_passed_step_routes_to_next() -> None:
    result = StepResult(step_id="verify", status=StepStatus.SUCCEEDED)

    decision = WorkflowRoutingPolicy().decide(result)

    assert decision.action is RouteAction.NEXT
    assert decision.outcome is WorkflowOutcome.PASSED


def test_failed_verification_step_is_handed_to_orchestration_without_runtime_route_mapping() -> None:
    result = StepResult(
        step_id="verify-work-item",
        status=StepStatus.FAILED,
        error="tests failed",
        metadata={"block_code": "PROJECT_SPECIFIC_TEST_BLOCK"},
    )

    decision = WorkflowRoutingPolicy().decide(result)

    assert decision.action is RouteAction.HANDOFF
    assert decision.outcome is WorkflowOutcome.FAILED
    assert decision.route_code == "PROJECT_SPECIFIC_TEST_BLOCK"
    assert decision.reason == "tests failed"


def test_non_verification_failed_step_stops_instead_of_orchestrating() -> None:
    result = StepResult(
        step_id="materialize-execution-report",
        status=StepStatus.FAILED,
        error="execution report materialization failed",
    )

    decision = WorkflowRoutingPolicy().decide(result)

    assert decision.action is RouteAction.STOP_FATAL
    assert decision.outcome is WorkflowOutcome.FATAL
    assert decision.from_step == "materialize-execution-report"


def test_failure_kind_is_preserved_for_orchestration_context() -> None:
    result = StepResult(
        step_id="verify-work-item",
        status=StepStatus.FAILED,
        error="implementation defect",
        failure_kind=FailureKind.IMPLEMENTATION,
    )

    decision = WorkflowRoutingPolicy().decide(result)

    assert decision.action is RouteAction.HANDOFF
    assert decision.failure_kind == "implementation"


def test_retry_budget_exceeded_becomes_fatal_stop() -> None:
    result = StepResult(
        step_id="verify-work-item",
        status=StepStatus.FAILED,
        error="same failure repeated",
        metadata={"block_code": "PROJECT_SPECIFIC_TEST_BLOCK"},
    )

    decision = WorkflowRoutingPolicy(retry_budget=2).decide(result, attempt=2)

    assert decision.action is RouteAction.STOP_FATAL
    assert decision.outcome is WorkflowOutcome.FATAL
    assert decision.route_code == "PROJECT_SPECIFIC_TEST_BLOCK"
    assert "same failure repeated" in decision.reason


def test_unknown_project_block_codes_are_valid_handoff_inputs() -> None:
    result = StepResult(
        step_id="promote-design-delta",
        status=StepStatus.BLOCKED,
        error="custom blocker",
        metadata={"route_code": "PRODUCT_DECISION_REQUIRED"},
    )

    decision = WorkflowRoutingPolicy().decide(result)

    assert decision.action is RouteAction.HANDOFF
    assert decision.outcome is WorkflowOutcome.BLOCKED
    assert decision.route_code == "PRODUCT_DECISION_REQUIRED"


def test_explicit_fatal_metadata_stops_immediately() -> None:
    result = StepResult(
        step_id="classify-diff",
        status=StepStatus.BLOCKED,
        error="unrelated dirty working tree is unsafe to modify",
        metadata={
            "block_code": "REPO_DIRTY_UNRELATED",
            "unsafe_to_retry": True,
        },
    )

    decision = WorkflowRoutingPolicy().decide(result)

    assert decision.action is RouteAction.STOP_FATAL
    assert decision.outcome is WorkflowOutcome.FATAL
    assert decision.route_code == "REPO_DIRTY_UNRELATED"
