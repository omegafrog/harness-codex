import json
from pathlib import Path

import pytest

from harness_codex.runtime import (
    ChangeSetCompletionBlocked,
    complete_change_set_if_ready,
)
from harness_codex.runtime.changes.parser import parse_changeset_markdown


CHANGESET = """# ChangeSet CHG-001

## 1. 메타데이터
|항목|값|
|---|---|
|ChangeSet ID|`CHG-001`|
|상태|active|

## 5. 영향 유스케이스
|UC ID|유스케이스 이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`UC-001`|결제 승인|update|`docs/use-cases/UC-001/`|planned|
|`UC-002`|결제 취소|update|`docs/use-cases/UC-002/`|planned|
"""


def write_active_changeset(repo: Path) -> None:
    active = repo / "docs/changes/active"
    active.mkdir(parents=True)
    (active / "CHG-001.md").write_text(CHANGESET, encoding="utf-8")


def load_changeset(repo: Path):
    return parse_changeset_markdown(
        (repo / "docs/changes/active/CHG-001.md").read_text(encoding="utf-8"),
        path=Path("docs/changes/active/CHG-001.md"),
    )


def write_completed_plan(repo: Path, work_item_id: str) -> None:
    path = repo / "docs/plans/completed" / work_item_id / "plan.md"
    path.parent.mkdir(parents=True)
    path.write_text(f"# Plan {work_item_id}\n", encoding="utf-8")


def write_successful_run(repo: Path, *, status: str = "succeeded") -> None:
    run_dir = repo / ".harness/runs/run-001"
    run_dir.mkdir(parents=True)
    (run_dir / "state.json").write_text(
        json.dumps(
            {
                "run_id": "run-001",
                "change_set_id": "CHG-001",
                "workflow_name": "changeset-use-case-workflow",
                "mode": "apply",
                "affected_use_cases": ["UC-001", "UC-002"],
                "affected_work_items": ["UC-001", "UC-002"],
                "status": status,
            }
        ),
        encoding="utf-8",
    )
    (run_dir / "report.json").write_text(
        json.dumps(
            {
                "run_id": "run-001",
                "change_set_id": "CHG-001",
                "workflow_name": "changeset-use-case-workflow",
                "mode": "apply",
                "status": status,
                "affected_use_cases": ["UC-001", "UC-002"],
                "failed_use_cases": [],
                "blocked_use_cases": [],
                "work_item_reports": [
                    {
                        "work_item_id": "UC-001",
                        "work_item_type": "use_case",
                        "active_plan_path": "docs/plans/active/UC-001/plan.md",
                        "completed_plan_path": "docs/plans/completed/UC-001/plan.md",
                        "status": "succeeded",
                        "verification_goal_path": "docs/use-cases/UC-001/e2e-goal.md",
                    },
                    {
                        "work_item_id": "UC-002",
                        "work_item_type": "use_case",
                        "active_plan_path": "docs/plans/active/UC-002/plan.md",
                        "completed_plan_path": "docs/plans/completed/UC-002/plan.md",
                        "status": "succeeded",
                        "verification_goal_path": "docs/use-cases/UC-002/e2e-goal.md",
                    },
                ],
            }
        ),
        encoding="utf-8",
    )


def test_complete_changeset_moves_active_file_and_writes_report(tmp_path: Path) -> None:
    write_active_changeset(tmp_path)
    write_completed_plan(tmp_path, "UC-001")
    write_completed_plan(tmp_path, "UC-002")
    write_successful_run(tmp_path)

    result = complete_change_set_if_ready(tmp_path, load_changeset(tmp_path), run_id="run-001")

    assert result.completed_path == Path("docs/changes/completed/CHG-001.md")
    assert result.completed_work_items == ("UC-001", "UC-002")
    assert not (tmp_path / "docs/changes/active/CHG-001.md").exists()
    assert (tmp_path / "docs/changes/completed/CHG-001.md").exists()
    report = (tmp_path / ".harness/runs/run-001/changeset-completion-report.md").read_text(
        encoding="utf-8"
    )
    assert "# ChangeSet Completion Report CHG-001" in report
    assert "`docs/plans/completed/UC-001/plan.md`" in report
    assert "status=succeeded" in report


def test_complete_changeset_rejects_missing_completed_plan(tmp_path: Path) -> None:
    write_active_changeset(tmp_path)
    write_completed_plan(tmp_path, "UC-001")
    write_successful_run(tmp_path)

    with pytest.raises(ChangeSetCompletionBlocked) as exc:
        complete_change_set_if_ready(tmp_path, load_changeset(tmp_path), run_id="run-001")

    assert "missing completed work item plans" in exc.value.reason
    assert (tmp_path / "docs/changes/active/CHG-001.md").exists()


def test_complete_changeset_rejects_active_plan_left_behind(tmp_path: Path) -> None:
    write_active_changeset(tmp_path)
    write_completed_plan(tmp_path, "UC-001")
    write_completed_plan(tmp_path, "UC-002")
    active_plan = tmp_path / "docs/plans/active/UC-002/plan.md"
    active_plan.parent.mkdir(parents=True)
    active_plan.write_text("# still active\n", encoding="utf-8")
    write_successful_run(tmp_path)

    with pytest.raises(ChangeSetCompletionBlocked) as exc:
        complete_change_set_if_ready(tmp_path, load_changeset(tmp_path), run_id="run-001")

    assert "active work item plans still exist" in exc.value.reason
    assert (tmp_path / "docs/changes/active/CHG-001.md").exists()


def test_complete_changeset_rejects_failed_latest_run(tmp_path: Path) -> None:
    write_active_changeset(tmp_path)
    write_completed_plan(tmp_path, "UC-001")
    write_completed_plan(tmp_path, "UC-002")
    write_successful_run(tmp_path, status="failed")

    with pytest.raises(ChangeSetCompletionBlocked) as exc:
        complete_change_set_if_ready(tmp_path, load_changeset(tmp_path), run_id="run-001")

    assert "latest run did not succeed" in exc.value.reason


def test_complete_changeset_is_idempotent_after_archive(tmp_path: Path) -> None:
    write_active_changeset(tmp_path)
    write_completed_plan(tmp_path, "UC-001")
    write_completed_plan(tmp_path, "UC-002")
    write_successful_run(tmp_path)
    change_set = load_changeset(tmp_path)

    first = complete_change_set_if_ready(tmp_path, change_set, run_id="run-001")
    second = complete_change_set_if_ready(tmp_path, change_set, run_id="run-001")

    assert first.already_completed is False
    assert second.already_completed is True
    assert second.completed_path == Path("docs/changes/completed/CHG-001.md")
