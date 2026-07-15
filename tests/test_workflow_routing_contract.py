from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_orchestration_routes_feature_and_maintenance_from_intent() -> None:
    orchestration = _read(".codex/agents/references/orchestration.md")
    main_steps = _read(".codex/workflow/main-steps.md")

    for intent in ("feature", "bugfix", "refactor"):
        assert f"`{intent}`" in orchestration

    assert "`feature`는 `harness-requirements`부터 시작한다" in orchestration
    assert "`bugfix`와 `refactor`는 `MAINT-<NNN>`" in orchestration
    assert "## Feature lane" in main_steps
    assert "## Maintenance lane" in main_steps
    assert "harness-maintenance-bootstrap" in main_steps


def test_maintenance_skill_keeps_branch_rules_in_one_level_reference() -> None:
    skill = _read(".codex/skills/harness-maintenance-bootstrap/SKILL.md")
    rules = _read(
        ".codex/skills/harness-maintenance-bootstrap/references/intake-rules.md"
    )
    spec_template = _read(
        ".harness/docs/templates/maintenance/maintenance-spec.md"
    )

    assert "orchestrator가 bugfix 또는 refactor" in skill
    assert "references/intake-rules.md" in skill
    assert "## Bugfix" not in skill
    assert "## Refactor" not in skill
    assert "## Bugfix" in rules
    assert "## Refactor" in rules
    assert "feature` 재분류 blocker" in rules
    assert "## 기대 동작 근거" in spec_template
    assert "## 보존 불변 조건" in spec_template
    assert "## 구조 목표" in spec_template
    assert len(skill.encode("utf-8")) < 1_200


def test_shared_downstream_uses_generic_work_item_plan() -> None:
    files = (
        ".codex/agents/references/implementation_planner.md",
        ".codex/agents/references/implementation_executor.md",
        ".codex/skills/harness-plan-document/references/write-rules.md",
        ".codex/agents/references/delivery_coordinator.md",
        ".codex/agents/references/reviewer.md",
    )

    for path in files:
        text = _read(path)
        assert "docs/plans/active/<WORK-ITEM-ID>/plan.md" in text, path
        assert "docs/changes/active/<CHG-ID>/plan.md" not in text, path


def test_planning_and_review_accept_both_work_item_types() -> None:
    planner = _read(".codex/agents/references/implementation_planner.md")
    reviewer = _read(".codex/agents/references/reviewer.md")
    technical_decisions = _read(".codex/agents/references/technical_decisions.md")

    for text in (planner, reviewer, technical_decisions):
        assert "UC:" in text
        assert "Maintenance:" in text

    assert "verification-goal.md" in planner
    assert "architecture impact" in reviewer
    assert "docs/maintenance/<MAINT-ID>/technical-decisions.md" in technical_decisions


def test_orchestration_supports_explicit_and_implicit_triggering() -> None:
    skill = _read(".codex/skills/harness-orchestrate-instruction/SKILL.md")
    metadata = _read(
        ".codex/skills/harness-orchestrate-instruction/agents/openai.yaml"
    )

    assert "사용자가 명시적으로 호출하거나 모델이" in skill
    assert "allow_implicit_invocation: true" in metadata


def test_modified_skill_descriptions_name_their_caller() -> None:
    callers = {
        "harness-maintenance-bootstrap": "orchestrator가",
        "harness-technical-decisions": "orchestrator가",
        "harness-technical-decision-document": "technical-decisions agent가",
        "harness-technical-decision-question": "technical-decisions agent가",
        "harness-code-planner": "orchestrator가",
        "harness-plan-document": "implementation planner가",
        "harness-plan-question": "implementation planner가",
        "harness-implementation-executor": "orchestrator가",
        "harness-delivery-coordination": "orchestrator가",
        "harness-review": "orchestrator가",
        "harness-review-document": "reviewer가",
        "harness-project-wiki": "orchestrator가",
    }

    for skill_name, caller in callers.items():
        frontmatter = _read(f".codex/skills/{skill_name}/SKILL.md").split("---", 2)[1]
        assert caller in frontmatter, skill_name


def test_document_skills_move_conditional_writes_to_references() -> None:
    skills = {
        "harness-plan-document": "UC는",
        "harness-technical-decision-document": "Maintenance:",
        "harness-review-document": "마지막 work item",
    }

    for skill_name, branch_marker in skills.items():
        skill = _read(f".codex/skills/{skill_name}/SKILL.md")
        rules = _read(f".codex/skills/{skill_name}/references/write-rules.md")
        assert "references/write-rules.md" in skill
        assert branch_marker not in skill
        assert branch_marker in rules
        assert len(skill.encode("utf-8")) < 1_200
