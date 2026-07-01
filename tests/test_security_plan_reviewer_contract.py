from pathlib import Path

from harness_codex.runtime.workflows.loader import load_named_workflow


REPO_ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_changeset_workflow_has_one_plan_writing_agent() -> None:
    workflow = load_named_workflow("changeset-use-case-workflow")
    plan = workflow.step_by_id("plan-work-item")
    review = workflow.step_by_id("review-work-item-plan")

    assert plan.agent_id == "implementation_planner"
    assert plan.skill_id == "harness-code-planner"
    assert plan.outputs == (Path("docs/plans/active/<WORK-ITEM-ID>/plan.md"),)
    assert review.needs == ("plan-work-item",)
    assert "secure-work-item-plan" not in workflow.step_ids()


def test_security_review_runs_only_after_implementation_verification() -> None:
    workflow = load_named_workflow("changeset-use-case-workflow")
    step_ids = workflow.step_ids()
    profile = workflow.step_by_id("materialize-security-profile")
    reviewer = workflow.step_by_id("review-work-item-security")

    assert profile.needs == ("verify-work-item",)
    assert step_ids.index("execute-work-item") < step_ids.index("verify-work-item")
    assert step_ids.index("verify-work-item") < step_ids.index("materialize-security-profile")
    assert step_ids.index("materialize-security-profile") < step_ids.index("review-work-item-security")
    assert reviewer.agent_id == "security_implementation_reviewer"
    assert reviewer.outputs == ()
    assert Path(
        ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/security/security-review-bundle/security-plan-tasks.md"
    ) not in reviewer.inputs


def test_security_implementation_reviewer_is_read_only_and_code_evidence_based() -> None:
    skill = read(".codex/skills/harness-security-implementation-reviewer/SKILL.md")

    assert "post-implementation review only" in skill
    assert "changed-code location" in skill
    assert "Do not edit implementation code, plans, or runtime output files." in skill
    assert "scope-expansion request" in skill
    assert "Required Implementation Corrections" in skill
