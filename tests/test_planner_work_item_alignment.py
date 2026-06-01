from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    absolute = REPO_ROOT / path
    text = absolute.read_text(encoding="utf-8")
    if absolute.name == "SKILL.md":
        detailed = absolute.parent / "references/detailed-instructions.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
    if absolute.suffix == ".toml":
        detailed = absolute.parent / "references" / f"{absolute.stem}.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
    return text


def test_harness_code_planner_uses_only_work_item_plan_paths() -> None:
    skill = read(".codex/skills/harness-code-planner/SKILL.md")

    assert "docs/plans/active/<WORK-ITEM-ID>/plan.md" in skill
    assert "docs/plans/completed/<WORK-ITEM-ID>/plan.md" in skill
    assert "docs/plans/active/plan.md" not in skill
    assert "docs/plans/complete/plan.md" not in skill
    assert "docs/plans/active/<UC-ID>/plan.md" not in skill
    assert "docs/plans/completed/<UC-ID>/plan.md" not in skill


def test_harness_code_planner_does_not_require_integrated_design_docs_as_primary_inputs() -> None:
    skill = read(".codex/skills/harness-code-planner/SKILL.md")

    assert "docs/changes/active/<CHG-ID>.md" in skill
    assert "docs/use-cases/<UC-ID>/" in skill
    assert "docs/maintenance/<MAINT-ID>/" in skill
    assert "Integrated documents under the design documentation area are source-of-truth references only" in skill
    assert "They are not the primary planning input" in skill

    forbidden_primary_phrases = [
        "Required Inputs\n\n- `docs/design/요구사항.md`",
        "turns `docs/design` and `ARCHITECTURE.md`",
        "Create the single active implementation plan",
    ]
    for phrase in forbidden_primary_phrases:
        assert phrase not in skill


def test_skill_agent_and_workflow_plan_paths_are_aligned() -> None:
    skill = read(".codex/skills/harness-code-planner/SKILL.md")
    planner = read(".codex/agents/implementation_planner.toml")
    workflow = read(".harness/workflows/changeset-use-case-workflow.yaml")

    expected_active = "docs/plans/active/<WORK-ITEM-ID>/plan.md"
    expected_completed = "docs/plans/completed/<WORK-ITEM-ID>/plan.md"

    assert expected_active in skill
    assert expected_completed in skill
    assert expected_active in planner
    assert expected_completed in planner
    assert expected_active in workflow


def test_skill_and_agent_document_type_specific_missing_input_blockers() -> None:
    combined = "\n".join(
        [
            read(".codex/skills/harness-code-planner/SKILL.md"),
            read(".codex/agents/implementation_planner.toml"),
        ]
    )

    assert "use-case.md" in combined
    assert "event-storming.md" in combined
    assert "e2e-goal.md" in combined
    assert "change-intent.md" in combined
    assert "affected-files.md" in combined
    assert "verification-goal.md" in combined
    assert "stop" in combined.lower()
