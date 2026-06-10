from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_plan_executor_skill() -> str:
    path = REPO_ROOT / ".codex/skills/harness-plan-executor/SKILL.md"
    text = path.read_text(encoding="utf-8")
    detailed = path.parent / "references/detailed-instructions.md"
    if detailed.exists():
        text += "\n" + detailed.read_text(encoding="utf-8")
    return text


def test_plan_executor_targets_one_work_item_plan() -> None:
    skill = read_plan_executor_skill()

    assert "docs/plans/active/<WORK-ITEM-ID>/plan.md" in skill
    assert "docs/plans/active/<UC-ID>/plan.md" in skill
    assert "docs/plans/active/<MAINT-ID>/plan.md" in skill
    assert "docs/plans/active/plan.md" not in skill
    assert "Do not execute or complete other active work-item plans" in skill


def test_plan_executor_uses_type_specific_goal_and_test_gate() -> None:
    skill = read_plan_executor_skill()

    assert "docs/use-cases/<UC-ID>/e2e-goal.md" in skill
    assert "docs/maintenance/<MAINT-ID>/verification-goal.md" in skill
    assert "docs/plans/active/<WORK-ITEM-ID>/verification.md" in skill
    assert ".codex/test-gate.yaml" in skill
    assert "./gradlew test" in skill
    assert "./gradlew e2eTest" in skill
    assert "For UC, verify `e2e-goal.md`" in skill
    assert "For maintenance, verify `verification-goal.md`" in skill
    assert "API-only probes do not complete a browser E2E goal" in skill


def test_plan_executor_remediates_only_implementation_failures() -> None:
    skill = read_plan_executor_skill()

    assert "Only for `IMPLEMENTATION_FAILURE`" in skill
    assert "UNCLEAR_E2E_GOAL" in skill
    assert "VERIFICATION_GOAL_UNCLEAR" in skill
    assert "DOCUMENT_DELTA_CONFLICT" in skill
    assert "UPSTREAM_DESIGN_CONFLICT" in skill
    assert "ENVIRONMENT_BLOCKER" in skill
    assert "Only for `IMPLEMENTATION_FAILURE`" in skill


def test_plan_executor_moves_only_completed_work_item_plan() -> None:
    skill = read_plan_executor_skill()

    assert (
        "docs/plans/active/<WORK-ITEM-ID>/plan.md -> docs/plans/completed/<WORK-ITEM-ID>/plan.md"
        in skill
    )
    assert "Move the plan only when all are true" in skill
