from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_plan_executor_skill() -> str:
    return (REPO_ROOT / ".codex/skills/harness-plan-executor/SKILL.md").read_text(
        encoding="utf-8"
    )


def test_plan_executor_targets_one_use_case_plan() -> None:
    skill = read_plan_executor_skill()

    assert "docs/plans/active/<UC-ID>/plan.md" in skill
    assert "docs/plans/active/plan.md" not in skill
    assert "Do not execute or complete other active UC plans" in skill


def test_plan_executor_uses_e2e_goal_and_test_gate() -> None:
    skill = read_plan_executor_skill()

    assert "docs/use-cases/<UC-ID>/e2e-goal.md" in skill
    assert ".codex/test-gate.yaml" in skill
    assert "./gradlew test" in skill
    assert "./gradlew e2eTest" in skill
    assert "UC E2E goal" in skill
    assert "Playwright MCP browser verification from the end user's perspective only when" in skill
    assert "otherwise using the existing API/runtime verification path" in skill
    assert "API-only or HTTP-only probes" in skill


def test_plan_executor_remediates_only_implementation_failures() -> None:
    skill = read_plan_executor_skill()

    assert "Only for `IMPLEMENTATION_FAILURE`" in skill
    assert "UNCLEAR_E2E_GOAL" in skill
    assert "DOCUMENT_DELTA_CONFLICT" in skill
    assert "UPSTREAM_DESIGN_CONFLICT" in skill
    assert "ENVIRONMENT_BLOCKER" in skill
    assert "do not add remediation tasks" in skill


def test_plan_executor_moves_only_completed_uc_plan() -> None:
    skill = read_plan_executor_skill()

    assert (
        "docs/plans/active/<UC-ID>/plan.md -> docs/plans/completed/<UC-ID>/plan.md"
        in skill
    )
    assert "all of these are true" in skill
