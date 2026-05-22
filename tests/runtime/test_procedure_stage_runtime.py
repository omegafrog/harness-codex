from pathlib import Path

from harness_codex.cli import main
from harness_codex.runtime.procedure_stages import (
    PROCEDURE_STAGES,
    ProcedureStage,
    procedure_stage,
    render_initial_changeset,
    update_changeset_stage_status,
    validate_procedure_stage_registry,
    verify_procedure_stage,
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


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


def test_all_procedure_stage_agents_and_skills_exist() -> None:
    problems = validate_procedure_stage_registry(_repo_root())

    assert problems == ()


def test_procedure_stage_registry_reports_missing_agent_and_skill(
    tmp_path: Path,
) -> None:
    stage = ProcedureStage(
        stage_id="sample-stage",
        display_name="Sample Stage",
        agent_id="missing_agent",
        skill_id="missing-skill",
        inputs=(),
        outputs=(),
    )

    problems = validate_procedure_stage_registry(tmp_path, (stage,))

    assert problems == (
        "sample-stage: missing agent config: .codex/agents/missing_agent.toml",
        "sample-stage: missing skill config: .codex/skills/missing-skill/SKILL.md",
    )


def test_procedure_stage_registry_reports_skill_name_mismatch(
    tmp_path: Path,
) -> None:
    (tmp_path / ".codex/agents").mkdir(parents=True)
    (tmp_path / ".codex/agents/sample_agent.toml").write_text(
        "name = \"sample_agent\"\n",
        encoding="utf-8",
    )
    skill_dir = tmp_path / ".codex/skills/sample-skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: other-skill\n---\n",
        encoding="utf-8",
    )
    stage = ProcedureStage(
        stage_id="sample-stage",
        display_name="Sample Stage",
        agent_id="sample_agent",
        skill_id="sample-skill",
        inputs=(),
        outputs=(),
    )

    problems = validate_procedure_stage_registry(tmp_path, (stage,))

    assert problems == (
        "sample-stage: skill name mismatch: .codex/skills/sample-skill/SKILL.md declares other-skill, expected sample-skill",
    )


def test_readme_staged_workflow_commands_match_procedure_stage_ids() -> None:
    readme = (_repo_root() / "README.md").read_text(encoding="utf-8")
    documented = {
        "requirements-definition",
        "use-case-definition",
        "event-storming",
        "ddd-architecture-definition",
        "plan-writing",
        "implementation",
    }
    stage_ids = {stage.stage_id for stage in PROCEDURE_STAGES}

    for command in documented:
        assert f"./harness {command}" in readme
    assert stage_ids == documented
