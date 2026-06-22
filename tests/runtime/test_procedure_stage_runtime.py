from pathlib import Path

import pytest

from harness_codex.runtime.procedure_stages import (
    PROCEDURE_STAGES,
    procedure_stage,
    render_initial_changeset,
    update_changeset_stage_status,
    verify_procedure_stage,
)


README_STAGE_IDS = (
    "requirements-definition",
    "ubiquitous-language-definition",
    "use-case-definition",
    "event-storming",
    "ddd-architecture-definition",
    "technical-decisions",
    "plan-writing",
    "implementation",
)


def test_procedure_registry_matches_readme_stage_order() -> None:
    assert tuple(stage.stage_id for stage in PROCEDURE_STAGES) == README_STAGE_IDS
    with pytest.raises(ValueError, match="unknown procedure stage: change-set-pr"):
        procedure_stage("change-set-pr")


def test_requirements_language_and_use_case_contracts_remain_ordered() -> None:
    requirements = procedure_stage("requirements-definition")
    language = procedure_stage("ubiquitous-language-definition")
    use_cases = procedure_stage("use-case-definition")

    assert requirements.agent_id == "requirements_interviewer"
    assert language.agent_id == "ubiquitous_language_reviewer"
    assert language.outputs == (Path("context.md"),)
    assert Path("context.md") in use_cases.inputs

    rendered = render_initial_changeset(
        change_set_id="CHG-001",
        title="Stage workflow",
        request_summary="Keep README stages only",
    )
    for previous, following in zip(README_STAGE_IDS, README_STAGE_IDS[1:]):
        assert rendered.index(f"|{previous}|") < rendered.index(f"|{following}|")


def test_stage_verifier_rejects_placeholder_content(tmp_path: Path) -> None:
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


def test_implementation_verifier_rejects_remaining_active_plan(tmp_path: Path) -> None:
    active = tmp_path / "docs/plans/active/UC-001/plan.md"
    active.parent.mkdir(parents=True)
    active.write_text("# Implementation Plan\n\n- [ ] Remaining task\n", encoding="utf-8")
    completed = tmp_path / "docs/plans/completed/UC-001/plan.md"
    completed.parent.mkdir(parents=True)
    completed.write_text("# Old completed plan\n", encoding="utf-8")

    passed, problems = verify_procedure_stage(
        tmp_path,
        procedure_stage("implementation"),
        change_set_id="CHG-20260608-001",
        uc_id="UC-001",
    )

    assert not passed
    assert "active plan remains: docs/plans/active/UC-001/plan.md" in problems
    assert any(problem.startswith("incomplete plan output:") for problem in problems)


def test_stage_status_is_durable_and_keeps_readme_order() -> None:
    text = render_initial_changeset(
        change_set_id="CHG-001",
        title="Note workflow",
        request_summary="Build note workflow",
    )
    updated = update_changeset_stage_status(
        text,
        stage=procedure_stage("technical-decisions"),
        status="blocked",
        notes="pending approval",
    )

    assert "|technical-decisions|Technical Decisions|blocked|" in updated
    assert updated.index("|technical-decisions|") < updated.index("|plan-writing|")
