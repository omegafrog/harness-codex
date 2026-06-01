import json
from pathlib import Path

from harness_codex.cli import main
from harness_codex.runtime.changes.models import AffectedWorkItem, ChangeSet, WorkItemType
from harness_codex.runtime.contract_validators import (
    CHANGESET_SLICE_PATH_CONTRACT,
    PLAN_RUN_EVIDENCE_CONTRACT,
    TECHNICAL_DECISION_PLAN_COVERAGE,
    USE_CASE_E2E_ALIGNMENT,
    validate_changeset_slice_paths,
    validate_contracts,
    validate_plan_run_evidence,
    validate_technical_decision_plan_coverage,
    validate_use_case_e2e_alignment,
)
from harness_codex.runtime.models import (
    ContractValidationSeverity,
    ContractValidationStatus,
)


def test_use_case_e2e_alignment_passes_when_outcome_terms_match(tmp_path: Path) -> None:
    work_item = _write_use_case(
        tmp_path,
        use_case="Goal: Buyer reserves a seat.\nResult: Seat is held for payment.\n",
        e2e="When the buyer reserves a seat\nThen the seat is held for payment.\n",
    )

    result = validate_use_case_e2e_alignment(tmp_path, work_item)

    assert result.contract_id == USE_CASE_E2E_ALIGNMENT
    assert result.status == ContractValidationStatus.PASS
    assert "seat" in result.evidence[0]


def test_use_case_e2e_alignment_fails_when_outcome_terms_diverge(tmp_path: Path) -> None:
    work_item = _write_use_case(
        tmp_path,
        use_case="Goal: Buyer reserves a seat.\nResult: Seat is held for payment.\n",
        e2e="When the buyer purchases a ticket\nThen the ticket is issued immediately.\n",
    )

    result = validate_use_case_e2e_alignment(tmp_path, work_item)

    assert result.status == ContractValidationStatus.FAIL
    assert result.severity == ContractValidationSeverity.BLOCKING
    assert "different outcome terms" in result.blocker


def test_technical_decision_plan_coverage_fails_without_plan_task(
    tmp_path: Path,
) -> None:
    work_item = _write_use_case(tmp_path)
    _write_plan(tmp_path, "UC-001", "- [ ] Implement payment confirmation.\n")
    (tmp_path / "docs/use-cases/UC-001/technical-decisions.md").write_text(
        "# Technical Decisions\n\nApproved decision: Duplicate payment requests must use idempotency keys.\n",
        encoding="utf-8",
    )

    result = validate_technical_decision_plan_coverage(tmp_path, work_item)

    assert result.contract_id == TECHNICAL_DECISION_PLAN_COVERAGE
    assert result.status == ContractValidationStatus.FAIL
    assert "idempotency keys" in result.evidence[0]


def test_technical_decision_plan_coverage_passes_with_test_or_verification_task(
    tmp_path: Path,
) -> None:
    work_item = _write_use_case(tmp_path)
    _write_plan(
        tmp_path,
        "UC-001",
        "- [ ] Implement payment confirmation with idempotency keys.\n"
        "- [ ] Add failure-path idempotency test.\n",
    )
    (tmp_path / "docs/use-cases/UC-001/technical-decisions.md").write_text(
        "# Technical Decisions\n\nApproved decision: Duplicate payment requests must use idempotency keys.\n",
        encoding="utf-8",
    )

    result = validate_technical_decision_plan_coverage(tmp_path, work_item)

    assert result.status == ContractValidationStatus.PASS


def test_changeset_slice_path_contract_fails_for_mismatched_uc_path(
    tmp_path: Path,
) -> None:
    change_set = ChangeSet(
        change_set_id="CHG-001",
        title="Bad slice",
        path=Path("docs/changes/active/CHG-001.md"),
        affected_work_items=(
            AffectedWorkItem(
                work_item_id="UC-001",
                work_item_type=WorkItemType.USE_CASE,
                name="Reserve seat",
                impact_type="modify",
                slice_path=Path("docs/use-cases/UC-999"),
            ),
        ),
    )

    result = validate_changeset_slice_paths(tmp_path, change_set)[0]

    assert result.contract_id == CHANGESET_SLICE_PATH_CONTRACT
    assert result.status == ContractValidationStatus.FAIL
    assert "docs/use-cases/UC-001" in result.blocker


def test_plan_run_evidence_contract_checks_report_fields_when_available(
    tmp_path: Path,
) -> None:
    work_item = _write_use_case(tmp_path)
    _write_plan(tmp_path, "UC-001", "- [x] Verify reservation.\n")
    change_set = ChangeSet(change_set_id="CHG-001", title="Contracts")
    run_dir = tmp_path / ".harness/runs/run-001"
    run_dir.mkdir(parents=True)
    (run_dir / "report.json").write_text(
        json.dumps(
            {
                "change_set_id": "CHG-001",
                "work_item_reports": [
                    {
                        "work_item_id": "UC-001",
                        "status": "succeeded",
                        "verification_result": "",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    result = validate_plan_run_evidence(tmp_path, change_set, work_item)

    assert result.contract_id == PLAN_RUN_EVIDENCE_CONTRACT
    assert result.status == ContractValidationStatus.FAIL
    assert "verification_result" in result.blocker


def test_plan_run_evidence_contract_is_info_pass_before_run_exists(tmp_path: Path) -> None:
    work_item = _write_use_case(tmp_path)
    _write_plan(tmp_path, "UC-001", "- [ ] Verify reservation.\n")
    change_set = ChangeSet(change_set_id="CHG-001", title="Contracts")

    result = validate_plan_run_evidence(tmp_path, change_set, work_item)

    assert result.status == ContractValidationStatus.PASS
    assert result.severity == ContractValidationSeverity.INFO
    assert result.evidence == ("No run evidence found yet.",)


def test_contracts_validate_cli_outputs_dashboard_ready_json(
    tmp_path: Path,
    capsys,
) -> None:
    _write_changeset(tmp_path)
    _write_use_case(tmp_path)
    _write_plan(
        tmp_path,
        "UC-001",
        "- [ ] Implement seat hold.\n- [ ] Add seat hold verification test.\n",
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "contracts",
            "validate",
            "CHG-001",
            "--work-item",
            "UC-001",
            "--json",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    payload = json.loads(output)
    assert {item["contract_id"] for item in payload} == {
        USE_CASE_E2E_ALIGNMENT,
        TECHNICAL_DECISION_PLAN_COVERAGE,
        CHANGESET_SLICE_PATH_CONTRACT,
        PLAN_RUN_EVIDENCE_CONTRACT,
    }
    assert all(item["from"] and item["to"] for item in payload)
    assert all(item["status"] in {"pass", "fail"} for item in payload)


def _write_changeset(tmp_path: Path, *, slice_path: str = "docs/use-cases/UC-001/") -> None:
    active = tmp_path / "docs/changes/active"
    active.mkdir(parents=True)
    (active / "CHG-001.md").write_text(
        f"""# ChangeSet CHG-001

## 1. Metadata
|Item|Value|
|---|---|
|ChangeSet ID|`CHG-001`|
|Status|active|

## 5. Affected Work Items
|Work Item ID|Type|Name|Impact|Slice Path|Status|
|---|---|---|---|---|---|
|`UC-001`|use_case|Reserve seat|modify|`{slice_path}`|active|
""",
        encoding="utf-8",
    )


def _write_use_case(
    tmp_path: Path,
    *,
    use_case: str = "Goal: Buyer reserves a seat.\nResult: Seat is held for payment.\n",
    e2e: str = "When the buyer reserves a seat\nThen the seat is held for payment.\n",
) -> AffectedWorkItem:
    use_case_dir = tmp_path / "docs/use-cases/UC-001"
    use_case_dir.mkdir(parents=True, exist_ok=True)
    (use_case_dir / "use-case.md").write_text(f"# UC-001\n\n{use_case}", encoding="utf-8")
    (use_case_dir / "e2e-goal.md").write_text(f"# E2E\n\n{e2e}", encoding="utf-8")
    (use_case_dir / "technical-decisions.md").write_text(
        "# Technical Decisions\n\nApproved decision: Seat hold must be idempotent.\n",
        encoding="utf-8",
    )
    return AffectedWorkItem(
        work_item_id="UC-001",
        work_item_type=WorkItemType.USE_CASE,
        name="Reserve seat",
        impact_type="modify",
        slice_path=Path("docs/use-cases/UC-001"),
    )


def _write_plan(tmp_path: Path, work_item_id: str, text: str) -> None:
    path = tmp_path / "docs/plans/active" / work_item_id / "plan.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# Plan\n\n" + text, encoding="utf-8")
