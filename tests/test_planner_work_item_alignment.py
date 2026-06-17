import re
from pathlib import Path

from harness_codex.runtime.changes.resolver import (
    _missing_maintenance_documents,
    _missing_use_case_documents,
)


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


def read_skill_contract() -> str:
    return read(".codex/skills/harness-code-planner/SKILL.md")


def read_agent_contract() -> str:
    path = ".codex/agents/implementation_planner.toml"
    return read(path)


def required_skill_paths(skill: str, section: str) -> tuple[str, ...]:
    match = re.search(
        rf"### {re.escape(section)}\n\nRequired:\n\n(?P<body>.*?)\n\nOptional",
        skill,
        flags=re.DOTALL,
    )
    assert match is not None
    return tuple(re.findall(r"`([^`]+)`", match.group("body")))


def test_harness_code_planner_uses_only_work_item_plan_paths() -> None:
    skill = read_skill_contract()

    assert "docs/plans/active/<WORK-ITEM-ID>/plan.md" in skill
    assert "docs/plans/completed/<WORK-ITEM-ID>/plan.md" in skill
    assert "docs/plans/active/plan.md" not in skill
    assert "docs/plans/complete/plan.md" not in skill
    assert "docs/plans/active/<UC-ID>/plan.md" not in skill
    assert "docs/plans/completed/<UC-ID>/plan.md" not in skill


def test_harness_code_planner_does_not_require_integrated_design_docs_as_primary_inputs() -> None:
    skill = read_skill_contract()

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
    skill = read_skill_contract()
    planner = read_agent_contract()
    workflow = read(".harness/workflows/changeset-use-case-workflow.yaml")
    skill_agent_prompt = read(".codex/skills/harness-code-planner/agents/openai.yaml")

    expected_active = "docs/plans/active/<WORK-ITEM-ID>/plan.md"
    expected_completed = "docs/plans/completed/<WORK-ITEM-ID>/plan.md"

    assert expected_active in skill
    assert expected_completed in skill
    assert ".codex/skills/harness-code-planner/references/detailed-instructions.md" in planner
    assert "docs/plans/active/<UC-ID>/plan.md" not in planner
    assert "docs/plans/completed/<UC-ID>/plan.md" not in planner
    assert expected_active in workflow
    assert expected_active in skill_agent_prompt
    assert "docs/plans/active/plan.md" not in skill_agent_prompt


def test_agent_reference_does_not_duplicate_long_planner_standards() -> None:
    planner = read_agent_contract()

    duplicated_headings = [
        "Required planning input:",
        "Stop conditions:",
        "Plan requirements:",
        "Checkbox rules:",
        "Completion move rule:",
        "Embedded test planning standards:",
        "Output template for docs/plans/active/<WORK-ITEM-ID>/plan.md:",
    ]
    for heading in duplicated_headings:
        assert heading not in planner


def test_skill_use_case_gate_matches_runtime_preflight(tmp_path: Path) -> None:
    skill = read_skill_contract()
    skill_paths = set(required_skill_paths(skill, "Use-case work-item slice"))
    runtime_paths = {
        str(path).replace("UC-001", "<UC-ID>")
        for path in _missing_use_case_documents(
            tmp_path,
            Path("docs/use-cases/UC-001"),
        )
    }

    assert skill_paths == runtime_paths


def test_skill_maintenance_gate_matches_runtime_preflight(tmp_path: Path) -> None:
    skill = read_skill_contract()
    skill_paths = set(required_skill_paths(skill, "Maintenance work-item slice"))
    runtime_paths = {
        str(path).replace("MAINT-001", "<MAINT-ID>")
        for path in _missing_maintenance_documents(
            tmp_path,
            Path("docs/maintenance/MAINT-001"),
        )
    }

    assert skill_paths == runtime_paths
