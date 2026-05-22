from pathlib import Path

from harness_codex.cli import main
from harness_codex.runtime.procedure_stages import (
    procedure_stage,
    render_initial_changeset,
    update_changeset_stage_status,
    verify_procedure_stage,
)


def test_procedure_stage_plan_uses_explicit_process_name(
    tmp_path: Path,
    capsys,
) -> None:
    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "event-storming",
            "CHG-001",
            "--uc",
            "UC-001",
            "--plan",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Stage: event-storming" in output
    assert "Procedure: Event Storming" in output
    assert "docs/use-cases/UC-001/event-storming.md" in output


def test_procedure_stage_preview_verifies_outputs(
    tmp_path: Path,
    capsys,
) -> None:
    change_dir = tmp_path / "docs/changes/active"
    change_dir.mkdir(parents=True)
    (change_dir / "CHG-001.md").write_text("# ChangeSet CHG-001\n", encoding="utf-8")

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "event-storming",
            "CHG-001",
            "--uc",
            "UC-001",
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Verification: failed" in output
    assert "missing output: docs/use-cases/UC-001/event-storming.md" in output


def test_procedure_stage_verifier_rejects_placeholder_content(tmp_path: Path) -> None:
    path = tmp_path / "docs/use-cases/UC-001/event-storming.md"
    path.parent.mkdir(parents=True)
    path.write_text("- Event storming has not been derived yet.\n", encoding="utf-8")

    passed, problems = verify_procedure_stage(
        tmp_path,
        procedure_stage("event-storming"),
        change_set_id="CHG-001",
        uc_id="UC-001",
    )

    assert not passed
    assert problems == (
        "unverified placeholder in docs/use-cases/UC-001/event-storming.md: has not been derived yet",
    )


def test_changeset_stage_status_is_durable_in_changeset_markdown() -> None:
    text = render_initial_changeset(
        change_set_id="CHG-001",
        title="Note workflow",
        request_summary="Build note workflow",
    )

    updated = update_changeset_stage_status(
        text,
        stage=procedure_stage("requirements-definition"),
        status="verified",
        notes="outputs verified",
    )

    assert "|requirements-definition|Requirements Definition|verified|" in updated
    assert "outputs verified" in updated
