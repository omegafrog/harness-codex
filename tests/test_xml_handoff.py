from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.verification_failure import structured_failure_from_report
from harness_codex.runtime.xml_handoff import (
    XmlHandoffValidationError,
    read_handoff,
    write_handoff,
)


def _verification_report(*, status: str, verdict_status: str, failure_class: str | None) -> dict[str, object]:
    return {
        "schema_version": 2,
        "change_set_id": "CHG-XML-001",
        "work_item_id": "UC-001",
        "run_id": "run-1",
        "status": status,
        "plan_path": "docs/plans/active/UC-001/plan.md",
        "plan_sha256": "abc",
        "verification_goal_path": "docs/use-cases/UC-001/e2e-goal.md",
        "evidence_items": [{"path": "evidence.txt", "content": "ok"}],
        "failure_class": failure_class,
        "verdict": {
            "status": verdict_status,
            "rule_id": "environment_blocker" if verdict_status == "blocked" else "verification",
            "reason": "verification result",
            "evidence_path": "evidence.txt",
            "violations": [],
        },
    }


@pytest.mark.parametrize(
    ("status", "verdict_status", "failure_class"),
    (
        ("PASS", "pass", None),
        ("FAIL", "fail", "implementation_failure"),
        ("FAIL", "blocked", "environment_blocker"),
    ),
)
def test_verification_report_round_trip(
    tmp_path: Path, status: str, verdict_status: str, failure_class: str | None
) -> None:
    payload = _verification_report(
        status=status, verdict_status=verdict_status, failure_class=failure_class
    )
    path = tmp_path / "verification.xml"

    write_handoff(path, "verification-report", payload)

    assert read_handoff(path, expected_type="verification-report") == payload


@pytest.mark.parametrize(
    ("status", "verdict_status", "failure_class"),
    (
        ("PASS", "fail", None),
        ("PASS", "blocked", None),
        ("PASS", "pass", "implementation_failure"),
        ("FAIL", "pass", "implementation_failure"),
        ("FAIL", "fail", None),
    ),
)
def test_verification_report_rejects_inconsistent_status(
    tmp_path: Path, status: str, verdict_status: str, failure_class: str | None
) -> None:
    with pytest.raises(XmlHandoffValidationError):
        write_handoff(
            tmp_path / "verification.xml",
            "verification-report",
            _verification_report(
                status=status, verdict_status=verdict_status, failure_class=failure_class
            ),
        )


def test_verification_report_rejects_invalid_verdict_shape(tmp_path: Path) -> None:
    payload = _verification_report(status="PASS", verdict_status="pass", failure_class=None)
    payload["verdict"] = {**payload["verdict"], "violations": {"bad": True}}  # type: ignore[index]

    with pytest.raises(XmlHandoffValidationError, match="violations must be a list"):
        write_handoff(tmp_path / "verification.xml", "verification-report", payload)


@pytest.mark.parametrize(
    "insertion",
    (
        lambda payload: payload.update(owner_stage="environment"),
        lambda payload: payload["verdict"].update(repair={}),  # type: ignore[union-attr]
        lambda payload: payload["verdict"]["violations"].append({"resume_target": "x"}),  # type: ignore[index]
        lambda payload: payload["evidence_items"].append({"recommended_resume_target": "x"}),  # type: ignore[union-attr]
        lambda payload: payload.update(evidence={"nested": [{"retry_target": "x"}]}),
    ),
)
def test_verification_report_rejects_routing_keys_at_any_depth(tmp_path: Path, insertion) -> None:
    payload = _verification_report(status="PASS", verdict_status="pass", failure_class=None)
    insertion(payload)

    with pytest.raises(XmlHandoffValidationError, match="routing or remediation"):
        write_handoff(tmp_path / "verification.xml", "verification-report", payload)


def test_structured_failure_uses_shared_routing_key_validation() -> None:
    payload = _verification_report(
        status="FAIL", verdict_status="blocked", failure_class="environment_blocker"
    )
    payload["verdict"]["violations"] = [{"remediation_route": "environment"}]  # type: ignore[index]

    assert structured_failure_from_report(payload) is None


def _execution_scope() -> dict[str, object]:
    return {
        "schema_version": 2,
        "change_set_id": "CHG-XML-001",
        "work_item_id": "MAINT-001",
        "active_plan_path": "docs/plans/active/MAINT-001/plan.md",
        "plan_sha256": "abc",
        "plan_fingerprint": "sha256:abc",
        "execution_report_path": ".harness/runs/run-1/work-items/MAINT-001/execution-report.xml",
    }


def test_execution_scope_round_trips_as_fixed_xml(tmp_path: Path) -> None:
    path = tmp_path / "execution-scope.xml"
    payload = _execution_scope()

    write_handoff(path, "execution-scope", payload)

    assert path.read_text(encoding="utf-8").startswith("<?xml")
    assert read_handoff(path, expected_type="execution-scope") == payload


def test_handoff_type_mismatch_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "execution-scope.xml"
    write_handoff(path, "execution-scope", _execution_scope())

    with pytest.raises(XmlHandoffValidationError, match="expected handoff type"):
        read_handoff(path, expected_type="finalization-report")


def test_finalization_contract_requires_workflow_and_status(tmp_path: Path) -> None:
    with pytest.raises(XmlHandoffValidationError, match="missing required fields"):
        write_handoff(
            tmp_path / "finalization.xml",
            "finalization-report",
            {"schema_version": 1, "workflow": "changeset-finalization-workflow"},
        )
