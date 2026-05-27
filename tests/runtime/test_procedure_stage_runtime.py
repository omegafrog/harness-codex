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


def test_ddd_stage_and_agent_use_sliced_event_storming_first() -> None:
    stage = procedure_stage("ddd-architecture-definition")

    assert Path("docs/use-cases/<UC-ID>/event-storming.md") in stage.inputs
    assert Path("docs/use-cases/<UC-ID>/ddd-design.md") in stage.outputs

    agent_text = Path(".codex/agents/ddd_architect.toml").read_text(
        encoding="utf-8"
    )
    assert "docs/use-cases/<UC-ID>/event-storming.md" in agent_text
    assert "read the selected slice documents first" in agent_text
    assert "entity_vo" in agent_text
    assert "behaviors" in agent_text
    assert "application_flow" in agent_text
    assert "aggregates" in agent_text
    assert "bounded_contexts" in agent_text
    assert "Impact Assessment" in agent_text
    assert "internal_http" in agent_text
    assert "domain_event" in agent_text
    assert "shared_database" in agent_text
    assert "Direct calls into another BC's internal model are forbidden." in agent_text
    assert "attributeName: Type (required|optional, rule/evidence)" in agent_text
    assert "VOName { fieldName: Type, ... }" in agent_text
    assert len(agent_text) < 9000
    assert "If docs/design/이벤트 스토밍.md does not exist" not in agent_text
    assert "Required input:\n- docs/design/이벤트 스토밍.md" not in agent_text
    assert "docs/use-cases/<UC-ID>/application-service.md" not in agent_text


def test_procedure_stage_order_requires_technical_decisions_before_planning() -> None:
    technical = procedure_stage("technical-decisions")
    planner = procedure_stage("plan-writing")

    assert technical.agent_id == "technical_decisions"
    assert technical.skill_id == "harness-technical-decisions"
    assert Path("docs/use-cases/<UC-ID>/ddd-design.md") in technical.inputs
    assert Path("docs/use-cases/<UC-ID>/technical-decisions.md") in technical.outputs
    assert Path("docs/use-cases/<UC-ID>/technical-decisions.md") in planner.inputs

    text = render_initial_changeset(
        change_set_id="CHG-001",
        title="Note workflow",
        request_summary="Build note workflow",
    )
    assert text.index("|ddd-architecture-definition|") < text.index("|technical-decisions|")
    assert text.index("|technical-decisions|") < text.index("|plan-writing|")


def test_technical_decisions_stage_rejects_pending_approval(tmp_path: Path) -> None:
    path = tmp_path / "docs/use-cases/UC-001/technical-decisions.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        "# UC-001. Technical Decisions\n\n"
        "## 1. Metadata\n"
        "|Item|Value|\n"
        "|---|---|\n"
        "|Approval Status|pending|\n",
        encoding="utf-8",
    )

    passed, problems = verify_procedure_stage(
        tmp_path,
        procedure_stage("technical-decisions"),
        change_set_id="CHG-001",
        uc_id="UC-001",
    )

    assert not passed
    assert problems == (
        "unverified placeholder in docs/use-cases/UC-001/technical-decisions.md: |Approval Status|pending|",
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


def test_changeset_stage_status_escapes_table_pipes_in_notes() -> None:
    text = render_initial_changeset(
        change_set_id="CHG-001",
        title="Note workflow",
        request_summary="Build note workflow",
    )

    updated = update_changeset_stage_status(
        text,
        stage=procedure_stage("technical-decisions"),
        status="blocked",
        notes="unverified placeholder: |Approval Status|pending|",
    )

    assert "unverified placeholder: \\|Approval Status\\|pending\\|" in updated


def test_changeset_stage_status_keeps_runtime_stage_order_after_added_stage() -> None:
    text = """# ChangeSet CHG-001

## 3. Runtime Procedure State

|Stage ID|Procedure|Status|Verified At|Notes|
|---|---|---|---|---|
|requirements-definition|Requirements Definition|verified|2026-01-01T00:00:00Z|-|
|use-case-definition|Use Case Definition|verified|2026-01-01T00:00:00Z|-|
|event-storming|Event Storming|verified|2026-01-01T00:00:00Z|-|
|ddd-architecture-definition|DDD Architecture Definition|verified|2026-01-01T00:00:00Z|-|
|plan-writing|plan.md Writing|blocked|2026-01-01T00:00:00Z|-|
|implementation|Implementation|pending|-|-|
"""

    updated = update_changeset_stage_status(
        text,
        stage=procedure_stage("technical-decisions"),
        status="blocked",
        notes="pending approval",
    )

    assert updated.index("|ddd-architecture-definition|") < updated.index("|technical-decisions|")
    assert updated.index("|technical-decisions|") < updated.index("|plan-writing|")
