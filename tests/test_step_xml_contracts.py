from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.step_xml_contracts import (
    ActualChange,
    DiffContractLevel,
    EditHypothesis,
    FrontierExpansion,
    ReadFrontierCandidate,
    StepXmlContract,
    TestEvidence,
    evaluate_diff_contract,
)


def test_read_frontier_is_not_an_executor_read_or_write_gate() -> None:
    plan = StepXmlContract(
        work_item_id="MAINT-001",
        work_item_type="maintenance",
        read_frontier=(
            ReadFrontierCandidate(
                path=Path("src/entry.py"),
                reason="failure starts here",
                profile="maintenance",
            ),
        ),
        edit_hypotheses=(
            EditHypothesis(
                area="runtime adapter behavior",
                reason="entry delegates to adapter",
                confidence="low",
            ),
        ),
    )
    execute = StepXmlContract(
        work_item_id="MAINT-001",
        work_item_type="maintenance",
        frontier_expansion=(
            FrontierExpansion(
                path=Path("src/adapter.py"),
                reason="entry delegates to adapter",
                edge_path="entry -> direct-call -> adapter",
            ),
        ),
        actual_changes=(
            ActualChange(
                path=Path("src/adapter.py"),
                action="modified",
                reason="adapter contained the failing behavior",
                linked_intent="fix runtime routing",
            ),
        ),
        test_evidence=(
            TestEvidence(
                command="pytest tests/test_entry.py",
                result="passed",
                reason="focused regression for fix runtime routing",
            ),
        ),
    )

    result = evaluate_diff_contract(
        plan_contract=plan,
        execute_contract=execute,
        git_diff_paths=["src/adapter.py"],
    )

    assert not result.blocked
    assert result.warnings[0].code == "FRONTIER_EXPANDED"


def test_unrecorded_git_diff_is_blocked() -> None:
    plan = StepXmlContract(work_item_id="MAINT-001", work_item_type="maintenance")
    execute = StepXmlContract(
        work_item_id="MAINT-001",
        work_item_type="maintenance",
        test_evidence=(TestEvidence(command="pytest", result="passed"),),
    )

    result = evaluate_diff_contract(
        plan_contract=plan,
        execute_contract=execute,
        git_diff_paths=["src/unexplained.py"],
    )

    assert result.blocked
    assert result.blockers[0].code == "MISSING_ACTUAL_CHANGE"


def test_actual_change_requires_linked_intent_and_test_evidence() -> None:
    plan = StepXmlContract(work_item_id="MAINT-001", work_item_type="maintenance")
    execute = StepXmlContract(
        work_item_id="MAINT-001",
        work_item_type="maintenance",
        actual_changes=(
            ActualChange(
                path=Path("src/fix.py"),
                action="modified",
                reason="fix bug",
            ),
        ),
    )

    result = evaluate_diff_contract(
        plan_contract=plan,
        execute_contract=execute,
        git_diff_paths=["src/fix.py"],
    )

    assert result.blocked
    assert {finding.code for finding in result.blockers} == {
        "MISSING_LINKED_INTENT",
        "MISSING_TEST_EVIDENCE",
    }


def test_cross_boundary_change_requires_boundary_edge() -> None:
    plan = StepXmlContract(work_item_id="UC-001", work_item_type="use_case")
    execute = StepXmlContract(
        work_item_id="UC-001",
        work_item_type="use_case",
        actual_changes=(
            ActualChange(
                path=Path("purchase/events/PaymentCompletedHandler.py"),
                action="modified",
                reason="cross-bc event handler update",
                linked_intent="confirm purchase after payment",
            ),
        ),
        test_evidence=(
            TestEvidence(
                command="pytest tests/purchase/test_payment_completed.py",
                result="passed",
                reason="payment completed event contract",
            ),
        ),
    )

    result = evaluate_diff_contract(
        plan_contract=plan,
        execute_contract=execute,
        git_diff_paths=["purchase/events/PaymentCompletedHandler.py"],
    )

    assert result.blocked
    assert any(finding.code == "MISSING_BOUNDARY_EDGE" for finding in result.blockers)


def test_use_case_test_obligations_are_explicit_plan_contracts() -> None:
    plan = StepXmlContract(
        work_item_id="UC-001",
        work_item_type="use_case",
        test_obligations=("reserveSeat rejects already reserved seat",),
    )
    execute = StepXmlContract(
        work_item_id="UC-001",
        work_item_type="use_case",
        actual_changes=(
            ActualChange(
                path=Path("reservation/domain/reservation.py"),
                action="modified",
                reason="enforce seat invariant",
                linked_intent="reserve seat use case",
            ),
        ),
        test_evidence=(
            TestEvidence(
                command="pytest tests/domain/test_reservation.py",
                result="passed",
                reason="reserveSeat rejects already reserved seat",
            ),
        ),
    )

    result = evaluate_diff_contract(
        plan_contract=plan,
        execute_contract=execute,
        git_diff_paths=["reservation/domain/reservation.py"],
    )

    assert not result.blocked
    assert all(finding.level is not DiffContractLevel.BLOCK for finding in result.findings)
