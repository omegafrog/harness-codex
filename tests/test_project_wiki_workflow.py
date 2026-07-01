from pathlib import Path

from harness_codex.runtime.workflows.loader import load_named_workflow


REPO_ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_project_wiki_assets_remain_available_as_an_explicit_operation() -> None:
    config = read(".codex/config.toml")
    agent = read(".codex/agents/wiki_curator.toml")
    skill = read(".codex/skills/harness-project-wiki/SKILL.md")
    details = read(
        ".codex/skills/harness-project-wiki/references/detailed-instructions.md"
    )

    assert "[agents.wiki_curator]" in config
    assert 'name = "wiki_curator"' in agent
    assert "docs/wiki/index.md" in skill
    assert "mkdocs build --strict" in details
    assert "./harness run wiki build" in details


def test_work_item_and_finalization_workflows_keep_wiki_explicit() -> None:
    work_item_workflow = load_named_workflow("changeset-use-case-workflow")
    finalization_workflow = load_named_workflow("changeset-finalization-workflow")
    work_item_step_ids = set(work_item_workflow.step_ids())
    finalization_step_ids = set(finalization_workflow.step_ids())

    assert {
        "load-change-set",
        "plan-work-item",
        "review-work-item-plan",
        "execute-work-item",
        "verify-work-item",
        "verify-work-item-security",
        "prepare-plan-repair",
        "complete-work-item-plan",
    } <= work_item_step_ids
    assert "classify-verification-result" not in work_item_step_ids
    assert "secure-work-item-plan" not in work_item_step_ids
    assert "create-change-set-pr" not in work_item_step_ids
    assert "complete-change-set" not in work_item_step_ids
    assert {
        "verify-all-work-items-completed",
        "create-change-set-pr",
        "complete-change-set",
    } <= finalization_step_ids
    assert "update-project-wiki" not in work_item_step_ids | finalization_step_ids
    assert "validate-project-wiki" not in work_item_step_ids | finalization_step_ids
    assert work_item_workflow.step_by_id("complete-work-item-plan").metadata[
        "execution_boundary"
    ] == "work_item"
    assert finalization_workflow.step_by_id("create-change-set-pr").metadata[
        "execution_boundary"
    ] == "changeset_finalization"
