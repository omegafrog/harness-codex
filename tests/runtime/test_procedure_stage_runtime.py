from hashlib import sha256
from pathlib import Path

from harness_codex.runtime.procedure_stages import (
    PROCEDURE_STAGES,
    README_STAGE_IDS,
    procedure_stage,
    render_initial_changeset,
    update_changeset_stage_status,
    verify_procedure_stage,
)


def test_procedure_registry_keeps_readme_stages_public_and_delivery_internal() -> None:
    stage_ids = tuple(stage.stage_id for stage in PROCEDURE_STAGES)

    assert stage_ids[: len(README_STAGE_IDS)] == README_STAGE_IDS
    assert stage_ids[-1] == "change-set-pr"
    assert procedure_stage("change-set-pr").skill_id is None
    assert stage_ids.index("technical-decisions") < stage_ids.index("design-visualization")
    assert stage_ids.index("design-visualization") < stage_ids.index("plan-writing")


def test_requirements_language_and_use_case_contracts_remain_ordered() -> None:
    requirements = procedure_stage("requirements-definition")
    language = procedure_stage("ubiquitous-language-definition")
    use_cases = procedure_stage("use-case-definition")
    diagrams = procedure_stage("design-visualization")
    plan_writing = procedure_stage("plan-writing")

    assert requirements.agent_id == "requirements_interviewer"
    assert language.agent_id == "ubiquitous_language_reviewer"
    assert language.outputs == (Path("context.md"),)
    assert Path("context.md") in use_cases.inputs
    assert diagrams.requires_uc
    assert Path("docs/use-cases/<UC-ID>/class-diagram.md") in plan_writing.inputs
    assert Path("docs/use-cases/<UC-ID>/flow-diagram.md") in plan_writing.inputs

    rendered = render_initial_changeset(
        change_set_id="CHG-001",
        title="Stage workflow",
        request_summary="Keep README stages public",
    )
    for previous, following in zip(README_STAGE_IDS, README_STAGE_IDS[1:]):
        assert rendered.index(f"|{previous}|") < rendered.index(f"|{following}|")
    assert rendered.index("|implementation|") < rendered.index("|change-set-pr|")


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


def test_design_visualization_verifier_rejects_stale_source_hash(tmp_path: Path) -> None:
    uc_id = "UC-001"
    change_set_id = "CHG-20260624-001"
    slice_path = tmp_path / "docs/use-cases" / uc_id
    slice_path.mkdir(parents=True)
    source_paths = (
        slice_path / "use-case.md",
        slice_path / "e2e-goal.md",
        slice_path / "event-storming.md",
        slice_path / "ddd-design.md",
        slice_path / "technical-decisions.md",
        tmp_path / "context.md",
        tmp_path / "ARCHITECTURE.md",
    )
    for source_path in source_paths:
        source_path.parent.mkdir(parents=True, exist_ok=True)
        source_path.write_text(f"# {source_path.name}\n", encoding="utf-8")

    (slice_path / "class-diagram.md").write_text(
        "# Class\n\n```mermaid\nclassDiagram\n    class Order\n```\n",
        encoding="utf-8",
    )
    (slice_path / "flow-diagram.md").write_text(
        "# Flow\n\n```mermaid\nflowchart TD\n    A --> B\n```\n",
        encoding="utf-8",
    )
    source_documents = {
        str(path.relative_to(tmp_path)): f"sha256:{sha256(path.read_bytes()).hexdigest()}"
        for path in source_paths
    }
    source_documents["context.md"] = "sha256:stale"
    (slice_path / "diagram-metadata.json").write_text(
        "{\n"
        f'  "change_set_id": "{change_set_id}",\n'
        f'  "uc_id": "{uc_id}",\n'
        '  "status": "verified",\n'
        '  "source_documents": {\n'
        + ",\n".join(
            f'    "{path}": "{digest}"'
            for path, digest in source_documents.items()
        )
        + "\n  }\n}\n",
        encoding="utf-8",
    )

    passed, problems = verify_procedure_stage(
        tmp_path,
        procedure_stage("design-visualization"),
        change_set_id=change_set_id,
        uc_id=uc_id,
    )

    assert not passed
    assert any("stale diagram source hash for context.md" in problem for problem in problems)


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
    assert updated.index("|technical-decisions|") < updated.index("|design-visualization|")
    assert updated.index("|design-visualization|") < updated.index("|plan-writing|")
