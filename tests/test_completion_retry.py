import json
from pathlib import Path

import pytest

from harness_codex.runtime.changes.models import AffectedWorkItem, ChangeSet, WorkItemType
from harness_codex.runtime.completion import (
    ChangeSetCompletionBlocked,
    complete_change_set_if_ready,
)


def test_completion_allows_retry_after_pr_delivery_failure(tmp_path: Path) -> None:
    _write_completion_fixture(tmp_path, run_status="failed", work_item_status="succeeded")

    result = complete_change_set_if_ready(
        tmp_path,
        _change_set(),
        run_id="run-test",
    )

    assert result.completed_path == Path("docs/changes/completed/CHG-TEST-001.md")
    assert (tmp_path / result.completed_path).exists()
    assert not (tmp_path / "docs/changes/active/CHG-TEST-001.md").exists()


def test_completion_blocks_retry_when_work_item_failed(tmp_path: Path) -> None:
    _write_completion_fixture(tmp_path, run_status="failed", work_item_status="failed")

    with pytest.raises(ChangeSetCompletionBlocked):
        complete_change_set_if_ready(
            tmp_path,
            _change_set(),
            run_id="run-test",
        )


def _change_set() -> ChangeSet:
    return ChangeSet(
        change_set_id="CHG-TEST-001",
        title="테스트 변경",
        path=Path("docs/changes/active/CHG-TEST-001.md"),
        affected_work_items=(
            AffectedWorkItem(
                work_item_id="UC-001",
                work_item_type=WorkItemType.USE_CASE,
                name="테스트 유스케이스",
                impact_type="update",
                slice_path=Path("docs/use-cases/UC-001"),
                status="ready",
            ),
        ),
    )


def _write_completion_fixture(
    root: Path,
    *,
    run_status: str,
    work_item_status: str,
) -> None:
    active = root / "docs/changes/active/CHG-TEST-001.md"
    active.parent.mkdir(parents=True)
    active.write_text("# 테스트 변경\n", encoding="utf-8")

    completed_plan = root / "docs/plans/completed/UC-001/plan.md"
    completed_plan.parent.mkdir(parents=True)
    completed_plan.write_text("# 완료 계획\n", encoding="utf-8")

    run_dir = root / ".harness/runs/run-test"
    (run_dir / "finalization").mkdir(parents=True)
    failed = ["UC-001"] if work_item_status != "succeeded" else []
    (run_dir / "report.json").write_text(
        json.dumps(
            {
                "run_id": "run-test",
                "change_set_id": "CHG-TEST-001",
                "status": run_status,
                "failed_use_cases": failed,
                "blocked_use_cases": [],
                "work_item_reports": [
                    {
                        "work_item_id": "UC-001",
                        "status": work_item_status,
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (run_dir / "finalization/report.json").write_text(
        json.dumps(
            {
                "status": "failed",
                "failed_step_id": "create-change-set-pr",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
