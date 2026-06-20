from pathlib import Path

from harness_codex.runtime.models import HARNESS_FULL_WORKFLOW
from harness_codex.runtime.workflows.loader import load_named_workflow


REPO_ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_security_plan_reviewer_agent_and_skill_are_registered() -> None:
    config = read(".codex/config.toml")
    agent = read(".codex/agents/security_plan_reviewer.toml")
    skill = read(".codex/skills/harness-security-plan-reviewer/SKILL.md")

    assert "[agents.security_plan_reviewer]" in config
    assert 'name = "security_plan_reviewer"' in agent
    assert "harness-security-plan-reviewer" in agent
    assert "OWASP ASVS 5.0.0" in skill
    assert "OWASP Top 10:2025" in skill
    assert "OWASP API Security Top 10:2023" in skill


def test_changeset_workflow_secures_plan_before_independent_review() -> None:
    workflow = load_named_workflow("changeset-use-case-workflow")
    security = workflow.step_by_id("secure-work-item-plan")
    review = workflow.step_by_id("review-work-item-plan")

    assert security.agent_id == "security_plan_reviewer"
    assert security.skill_id == "harness-security-plan-reviewer"
    assert security.needs == ("plan-work-item",)
    assert security.outputs == (
        Path("docs/plans/active/<WORK-ITEM-ID>/plan.md"),
    )
    assert review.needs == ("secure-work-item-plan",)


def test_full_workflow_secures_plan_before_independent_review() -> None:
    security = HARNESS_FULL_WORKFLOW.step_by_id("secure-use-case-plan")
    review = HARNESS_FULL_WORKFLOW.step_by_id("review-use-case-plan")

    assert security.agent_id == "security_plan_reviewer"
    assert security.skill_id == "harness-security-plan-reviewer"
    assert security.needs == ("planner-create-use-case-plan",)
    assert security.outputs == (Path("docs/plans/active/<UC-ID>/plan.md"),)
    assert review.needs == ("secure-use-case-plan",)


def test_security_reviewer_is_plan_only_and_requires_traceable_tasks() -> None:
    reference = read(".codex/agents/references/security_plan_reviewer.md")
    baseline = read(
        ".codex/skills/harness-security-plan-reviewer/references/owasp-baseline.md"
    )
    skill = read(".codex/skills/harness-security-plan-reviewer/SKILL.md")

    assert "Edit only the runtime-declared" in reference
    assert "Do not implement code" in reference
    assert "Do not fabricate ASVS requirement identifiers" in reference
    assert "implementation tasks" in baseline
    assert "focused tests" in baseline
    assert "verification command" in baseline
    assert "minimal plan delta" in reference
    assert "Do not rewrite or narrate the full plan" in reference
    assert "Return/apply only a minimal delta" in skill
    assert "changed plan" in skill and "sections" in skill
