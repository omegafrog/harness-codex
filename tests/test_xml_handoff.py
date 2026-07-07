from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.xml_handoff import (
    XmlHandoffValidationError,
    read_handoff,
    write_handoff,
)


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
        read_handoff(path, expected_type="verification-report")


def test_verification_status_is_fixed_by_xml_contract(tmp_path: Path) -> None:
    with pytest.raises(XmlHandoffValidationError, match="PASS or FAIL"):
        write_handoff(
            tmp_path / "verification.xml",
            "verification-report",
            {
                "schema_version": 1,
                "change_set_id": "CHG-XML-002",
                "work_item_id": "MAINT-002",
                "run_id": "run-2",
                "status": "completed",
            },
        )


def test_finalization_contract_requires_workflow_and_status(tmp_path: Path) -> None:
    with pytest.raises(XmlHandoffValidationError, match="missing required fields"):
        write_handoff(
            tmp_path / "finalization.xml",
            "finalization-report",
            {"schema_version": 1, "workflow": "changeset-finalization-workflow"},
        )
