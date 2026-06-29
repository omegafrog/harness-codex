from __future__ import annotations

import json
import os
from pathlib import Path

from harness_codex.cli import main
from harness_codex.runtime.contracts import contract_dashboard_projection


CHANGESET = """# ChangeSet CHG-001

## 1. Metadata
|Item|Value|
|---|---|
|ChangeSet ID|`CHG-001`|
|Status|active|

## 5. Affected Use Cases
|UC ID|Use Case Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|
|`UC-001`|Save Note|update|`docs/use-cases/UC-001`|planned|

## 7. Verification Goal Changes
|Work Item ID|Verification Goal Path|Change Status|Approval Status|Notes|
|---|---|---|---|---|
|`UC-001`|`docs/use-cases/UC-001/e2e-goal.md`|new|approved|Ready|

## 8. Planner Input Scope
- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`
"""


def _write_changeset(root: Path, body: str = CHANGESET) -> None:
    path = root / "docs/changes/active/CHG-001.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")


def _write_ready_chain(root: Path) -> None:
    files = {
        "docs/use-cases/UC-001/use-case.md": "# Use Case\n",
        "docs/use-cases/UC-001/e2e-goal.md": "# E2E\n",
        "docs/use-cases/UC-001/event-storming.md": "# Event Storming\n",
        "docs/use-cases/UC-001/ddd-design.md": "# DDD Design\n",
        "docs/use-cases/UC-001/technical-decisions.md": """# Technical Decisions

## 1. Metadata
|Item|Value|
|---|---|
|Approval Status|approved|

## 7. Pending Decisions
- None
""",
        "docs/plans/active/UC-001/plan.md": "# Plan\n",
    }
    for index, (path, text) in enumerate(files.items(), start=1):
        absolute = root / path
        absolute.parent.mkdir(parents=True, exist_ok=True)
        absolute.write_text(text, encoding="utf-8")
        os.utime(absolute, (index, index))


def _work_item(projected: dict) -> dict:
    return projected["change_sets"][0]["work_items"][0]


def test_contract_dashboard_projects_ready_document_chain(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_ready_chain(tmp_path)

    projected = contract_dashboard_projection(tmp_path)
    item = _work_item(projected)

    assert projected["change_sets"][0]["status"] == "active"
    assert item["status"] == "ready"
    assert {document["type"] for document in item["documents"]} == {
        "use_case",
        "e2e_goal",
        "event_storming",
        "ddd_design",
        "technical_decisions",
        "plan",
    }
    assert all(document["status"] == "ready" for document in item["documents"])
    assert all(document["checksum"] for document in item["documents"])
    assert all(edge["status"] == "pass" for edge in item["contract_edges"])


def test_contract_dashboard_marks_missing_document_and_failed_edge(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_ready_chain(tmp_path)
    (tmp_path / "docs/use-cases/UC-001/event-storming.md").unlink()

    item = _work_item(contract_dashboard_projection(tmp_path))

    event_doc = next(document for document in item["documents"] if document["type"] == "event_storming")
    edge = next(edge for edge in item["contract_edges"] if edge["contract"] == "e2e_event_storming_traceability")
    assert item["status"] == "blocked"
    assert event_doc["status"] == "missing"
    assert edge["status"] == "fail"
    assert "Target document missing" in edge["blocker"]


def test_contract_dashboard_marks_stale_document(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_ready_chain(tmp_path)
    source = tmp_path / "docs/use-cases/UC-001/use-case.md"
    target = tmp_path / "docs/use-cases/UC-001/e2e-goal.md"
    os.utime(source, (20, 20))
    os.utime(target, (10, 10))

    item = _work_item(contract_dashboard_projection(tmp_path))

    e2e_doc = next(document for document in item["documents"] if document["type"] == "e2e_goal")
    edge = next(edge for edge in item["contract_edges"] if edge["contract"] == "use_case_e2e_alignment")
    assert e2e_doc["status"] == "stale"
    assert e2e_doc["stale"] is True
    assert edge["status"] == "fail"
    assert "Target document stale" in edge["blocker"]


def test_contract_dashboard_marks_failed_technical_decision_plan_edge(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_ready_chain(tmp_path)
    (tmp_path / "docs/use-cases/UC-001/technical-decisions.md").write_text(
        """# Technical Decisions

## 1. Metadata
|Item|Value|
|---|---|
|Approval Status|approved|

## 7. Pending Decisions
- None

## Approved Decisions
- `idempotency` must be verified in the plan.
""",
        encoding="utf-8",
    )
    os.utime(tmp_path / "docs/use-cases/UC-001/technical-decisions.md", (20, 20))
    os.utime(tmp_path / "docs/plans/active/UC-001/plan.md", (30, 30))

    item = _work_item(contract_dashboard_projection(tmp_path))

    edge = next(edge for edge in item["contract_edges"] if edge["contract"] == "technical_decision_plan_coverage")
    assert edge["status"] == "fail"
    assert edge["blocker"] == "Approved technical decision has no plan coverage: idempotency"


def test_contract_dashboard_reads_korean_technical_decision_sections(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_ready_chain(tmp_path)
    (tmp_path / "docs/plans/active/UC-001/plan.md").write_text(
        "# Plan\n\n- idempotency 검증을 포함한다.\n",
        encoding="utf-8",
    )
    (tmp_path / "docs/use-cases/UC-001/technical-decisions.md").write_text(
        """# UC-001. 기술 결정

## 1. 메타데이터
|항목|값|
|---|---|
|Approval Status|approved|

## 7. 보류 중인 결정
- 없음

## 3. 승인된 결정
- `idempotency`는 계획에서 검증해야 한다.
""",
        encoding="utf-8",
    )
    os.utime(tmp_path / "docs/use-cases/UC-001/technical-decisions.md", (20, 20))
    os.utime(tmp_path / "docs/plans/active/UC-001/plan.md", (30, 30))

    item = _work_item(contract_dashboard_projection(tmp_path))

    edge = next(edge for edge in item["contract_edges"] if edge["contract"] == "technical_decision_plan_coverage")
    decisions = next(
        document
        for document in item["documents"]
        if document["type"] == "technical_decisions"
    )
    assert decisions["status"] == "ready"
    assert decisions["blockers"] == []
    assert edge["status"] == "pass"


def test_dashboard_contracts_cli_outputs_json(tmp_path: Path, capsys) -> None:
    _write_changeset(tmp_path)
    _write_ready_chain(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "dashboard",
            "contracts",
            "--change-set",
            "CHG-001",
            "--format",
            "json",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert json.loads(output)["change_sets"][0]["id"] == "CHG-001"
