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


def test_implementation_workflow_keeps_delivery_internal_and_wiki_explicit() -> None:
    workflow = load_named_workflow("changeset-use-case-workflow")
    step_ids = set(workflow.step_ids())

    assert {
        "load-change-set",
        "plan-work-item",
        "secure-work-item-plan",
        "review-work-item-plan",
        "execute-work-item",
        "verify-work-item",
        "verify-work-item-security",
        "classify-verification-result",
        "remediate-work-item",
        "complete-work-item-plan",
        "create-change-set-pr",
        "complete-change-set",
    } <= step_ids
    assert "update-project-wiki" not in step_ids
    assert "validate-project-wiki" not in step_ids
    assert workflow.step_by_id("create-change-set-pr").metadata["run_on_final_work_item_only"] is True
