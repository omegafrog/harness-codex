import json
import subprocess
from pathlib import Path


SCRIPT = (
    Path(__file__).parents[1]
    / ".codex"
    / "skills"
    / "harness-reset-technical-decisions"
    / "scripts"
    / "reset.py"
)


def test_reset_script_discards_only_selected_technical_decisions_state(
    tmp_path: Path,
) -> None:
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    change_set_path.parent.mkdir(parents=True)
    change_set_path.write_text(
        "\n".join(
            [
                "# ChangeSet CHG-001",
                "",
                "## 3. Runtime Procedure State",
                "",
                "|Stage ID|Procedure|Status|Verified At|Notes|",
                "|---|---|---|---|---|",
                "|technical-decisions|Technical Decisions|blocked|-|needs input|",
                "|plan-writing|Plan Writing|pending|-|-|",
                "",
            ]
        ),
        encoding="utf-8",
    )
    selected_artifact = (
        tmp_path / "docs/use-cases/UC-001/technical-decisions.md"
    )
    selected_artifact.parent.mkdir(parents=True)
    selected_artifact.write_text("draft", encoding="utf-8")
    other_artifact = tmp_path / "docs/use-cases/UC-002/technical-decisions.md"
    other_artifact.parent.mkdir(parents=True)
    other_artifact.write_text("keep", encoding="utf-8")

    selected_session = tmp_path / ".harness/runs/run-selected/grill-me-session.json"
    selected_session.parent.mkdir(parents=True)
    selected_session.write_text(
        json.dumps(
            {
                "change_set_id": "CHG-001",
                "stage": "technical-decisions",
                "uc_id": "UC-001",
                "status": "needs_input",
                "answers": [{"question": "Old?", "answer": "Old answer"}],
                "pending_questions": [{"question": "Old?", "recommended": "Old"}],
            }
        ),
        encoding="utf-8",
    )
    other_session = tmp_path / ".harness/runs/run-other/grill-me-session.json"
    other_session.parent.mkdir(parents=True)
    other_session.write_text(
        json.dumps(
            {
                "change_set_id": "CHG-001",
                "stage": "technical-decisions",
                "uc_id": "UC-002",
                "status": "needs_input",
                "pending_questions": [{"question": "Keep?", "recommended": "Keep"}],
            }
        ),
        encoding="utf-8",
    )
    job_path = tmp_path / ".harness/ui/stage-rerun-jobs/CHG-001.json"
    job_path.parent.mkdir(parents=True)
    job_path.write_text(
        json.dumps(
            {
                "stage_id": "technical-decisions",
                "uc_id": "UC-001",
                "status": "needs_input",
            }
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [
            "python3",
            str(SCRIPT),
            "--repo-root",
            str(tmp_path),
            "--change-set",
            "CHG-001",
            "--uc",
            "UC-001",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["artifact_deleted"] is True
    assert payload["persisted_job_deleted"] is True
    assert payload["stage_row_updated"] is True
    assert not selected_artifact.exists()
    assert other_artifact.read_text(encoding="utf-8") == "keep"
    assert not job_path.exists()

    selected = json.loads(selected_session.read_text(encoding="utf-8"))
    assert selected["status"] == "cancelled"
    assert selected["pending_questions"] == []
    assert selected["answers"] == [{"question": "Old?", "answer": "Old answer"}]
    other = json.loads(other_session.read_text(encoding="utf-8"))
    assert other["status"] == "needs_input"
    assert "|technical-decisions|Technical Decisions|pending|" in (
        change_set_path.read_text(encoding="utf-8")
    )


def test_reset_script_rejects_path_traversal_id(tmp_path: Path) -> None:
    result = subprocess.run(
        [
            "python3",
            str(SCRIPT),
            "--repo-root",
            str(tmp_path),
            "--change-set",
            "../outside",
            "--uc",
            "UC-001",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "unsupported characters" in result.stdout


def test_reset_script_does_not_delete_artifact_without_stage_metadata(
    tmp_path: Path,
) -> None:
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    change_set_path.parent.mkdir(parents=True)
    change_set_path.write_text("# ChangeSet CHG-001\n", encoding="utf-8")
    artifact = tmp_path / "docs/use-cases/UC-001/technical-decisions.md"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("keep", encoding="utf-8")

    result = subprocess.run(
        [
            "python3",
            str(SCRIPT),
            "--repo-root",
            str(tmp_path),
            "--change-set",
            "CHG-001",
            "--uc",
            "UC-001",
        ],
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 2
    assert "no technical-decisions stage metadata" in result.stdout
    assert artifact.read_text(encoding="utf-8") == "keep"
