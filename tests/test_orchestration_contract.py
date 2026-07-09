from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.models import StepStatus
from harness_codex.runtime.orchestration_contract import (
    OrchestrationDecision,
    SubagentInvocation,
    SubagentStepResult,
)


def test_orchestration_decision_selects_subagent_without_verifier_routing_fields() -> None:
    invocation = SubagentInvocation(
        step_id="plan-work-item",
        agent_id="implementation_planner",
        skill_id="harness-code-planner",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )
    decision = OrchestrationDecision(
        status="continue",
        reason="planner owns next correction",
        next_invocation=invocation,
    )

    assert decision.status == "continue"
    assert decision.next_invocation == invocation
    assert not hasattr(decision, "owner_stage")
    assert not hasattr(decision, "recommended_resume_target")


def test_subagent_returns_step_result_not_next_route() -> None:
    result = SubagentStepResult(
        step_id="verify-work-item",
        status=StepStatus.BLOCKED,
        reason="static gate failed",
        evidence_path=".harness/runs/run-1/work-items/UC-001/verification/verification.xml",
    )

    assert result.status is StepStatus.BLOCKED
    assert result.evidence_path.endswith("verification.xml")
    assert not hasattr(result, "next_step")
    assert not hasattr(result, "retry_target")
