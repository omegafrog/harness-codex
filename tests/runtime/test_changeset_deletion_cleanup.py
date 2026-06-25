from __future__ import annotations

import json
from pathlib import Path

from harness_codex.cli import main
from harness_codex.runtime.dashboard import load_dashboard_runs
from harness_codex.runtime.document_dashboard import delete_active_changeset
from harness_codex.runtime.models import RunMode
from harness_codex.runtime.state import RunState, RunStateStore


def _write_active_changeset(root: Path, change_set_id: str) -> Path:
    path = root / "docs" / "changes" / "active" / f"{change_set_id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# ChangeSet {change_set_id}\n", encoding="utf-8")
    return path


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _write_runtime_artifacts(root: Path, change_set_id: str) -> None:
    _write_json(
        root / ".harness" / "ui" / "change-sets" / change_set_id / "harvest-session.json",
        {"change_set_id": change_set_id, "active_stage": "eventStorming"},
    )
    _write_json(
        root / ".harness" / "ui" / "stage-rerun-jobs" / f"{change_set_id}.json",
        {"change_set_id": change_set_id, "status": "needs_input"},
    )
    _write_json(
        root / ".harness" / "runs" / "run-state" / "state.json",
        {"run_id": "run-state", "change_set_id": change_set_id},
    )
    _write_json(
        root / ".harness" / "runs" / "run-grill" / "grill-me-session.json",
        {"change_set_id": change_set_id, "status": "needs_input"},
    )
    _write_json(
        root / ".harness" / "ui" / "harvest-session.json",
        {"active_stage": "eventStorming"},
    )


def test_cli_changes_delete_removes_only_deleted_changeset_runtime_artifacts(
    tmp_path: Path,
    capsys,
) -> None:
    _write_active_changeset(tmp_path, "CHG-001")
    _write_runtime_artifacts(tmp_path, "CHG-001")
    _write_json(
        tmp_path / ".harness" / "runs" / "run-other" / "state.json",
        {"run_id": "run-other", "change_set_id": "CHG-002"},
    )
    source_document = tmp_path / "docs" / "use-cases" / "UC-001" / "use-case.md"
    source_document.parent.mkdir(parents=True)
    source_document.write_text("# UC-001\n", encoding="utf-8")

    exit_code = main(["--repo-root", str(tmp_path), "changes", "delete", "CHG-001"])

    assert exit_code == 0
    assert "DELETED: docs/changes/active/CHG-001.md" in capsys.readouterr().out
    assert not (tmp_path / "docs/changes/active/CHG-001.md").exists()
    assert not (tmp_path / ".harness/ui/change-sets/CHG-001").exists()
    assert not (tmp_path / ".harness/ui/stage-rerun-jobs/CHG-001.json").exists()
    assert not (tmp_path / ".harness/runs/run-state").exists()
    assert not (tmp_path / ".harness/runs/run-grill").exists()
    assert not (tmp_path / ".harness/ui/harvest-session.json").exists()
    assert (tmp_path / ".harness/runs/run-other/state.json").exists()
    assert source_document.exists()


def test_dashboard_delete_uses_the_same_runtime_cleanup(tmp_path: Path) -> None:
    _write_active_changeset(tmp_path, "CHG-001")
    _write_runtime_artifacts(tmp_path, "CHG-001")

    result = delete_active_changeset(tmp_path, "CHG-001")

    assert result == {
        "id": "CHG-001",
        "deleted_path": "docs/changes/active/CHG-001.md",
    }
    assert not (tmp_path / ".harness/ui/change-sets/CHG-001").exists()
    assert not (tmp_path / ".harness/runs/run-state").exists()


def test_dashboard_hides_orphan_run_state_when_changeset_no_longer_exists(
    tmp_path: Path,
) -> None:
    RunStateStore(tmp_path).save(
        RunState(
            run_id="run-orphan",
            change_set_id="CHG-ORPHAN",
            workflow_name="changeset-session",
            mode=RunMode.APPLY,
            affected_use_cases=(),
        )
    )

    assert load_dashboard_runs(tmp_path) == ()
