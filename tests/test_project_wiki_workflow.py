from pathlib import Path

from harness_codex.runtime.models import (
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepStatus,
)
from harness_codex.runtime.runner import BasicStepRunner
from harness_codex.runtime.workflows.loader import load_named_workflow


REPO_ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_project_wiki_agent_and_skill_contracts_are_registered() -> None:
    config = read(".codex/config.toml")
    agent = read(".codex/agents/wiki_curator.toml")
    reference = read(".codex/agents/references/wiki_curator.md")
    skill = read(".codex/skills/harness-project-wiki/SKILL.md")
    details = read(
        ".codex/skills/harness-project-wiki/references/detailed-instructions.md"
    )
    mkdocs_template = read(
        ".codex/skills/harness-project-wiki/assets/mkdocs.yml"
    )
    requirements_template = read(
        ".codex/skills/harness-project-wiki/assets/requirements.txt"
    )
    build_script = read(
        ".codex/skills/harness-project-wiki/assets/build-wiki.sh"
    )

    assert "[agents.wiki_curator]" in config
    assert 'config_file = "agents/wiki_curator.toml"' in config
    assert 'name = "wiki_curator"' in agent
    assert ".codex/agents/references/wiki_curator.md" in agent
    assert ".codex/skills/harness-project-wiki/SKILL.md" in agent
    assert "docs/wiki/index.md" in reference
    assert "docs/wiki/index.md" in skill
    assert "mkdocs-material==9.7.6" in reference
    assert "mkdocs-material==9.7.6" in details
    assert "mkdocs build --strict" in details
    assert "./harness run wiki build" in details
    assert "scripts/build-wiki.sh" in details
    assert "scripts/serve-wiki.sh" in details
    assert "verified current behavior" in details
    assert "docs_dir: docs/wiki" in mkdocs_template
    assert "site_dir: .harness/wiki-site" in mkdocs_template
    assert "name: material" in mkdocs_template
    assert "  - search" in mkdocs_template
    assert requirements_template.strip() == "mkdocs-material==9.7.6"
    assert "venv/bin/python3" in build_script
    assert "mkdocs build --strict" in build_script


def test_changeset_workflow_updates_wiki_before_completion() -> None:
    workflow = load_named_workflow("changeset-use-case-workflow")
    wiki = workflow.step_by_id("update-project-wiki")
    validation = workflow.step_by_id("validate-project-wiki")
    completion = workflow.step_by_id("complete-change-set")

    assert wiki.agent_id == "wiki_curator"
    assert wiki.skill_id == "harness-project-wiki"
    assert wiki.needs == ("complete-work-item-plan",)
    assert wiki.outputs == (
        Path("docs/wiki/index.md"),
        Path("docs/wiki/requirements.txt"),
        Path("mkdocs.yml"),
        Path("scripts/build-wiki.sh"),
        Path("scripts/serve-wiki.sh"),
    )
    assert wiki.metadata["run_on_final_work_item_only"] is True
    assert validation.needs == ("update-project-wiki",)
    assert validation.command == "./harness run wiki build"
    assert validation.outputs == (Path(".harness/wiki-site/index.html"),)
    assert validation.metadata["run_on_final_work_item_only"] is True
    assert completion.needs == ("validate-project-wiki",)


def test_orchestrators_require_project_wiki_gate() -> None:
    post_harvest = read(
        ".codex/skills/harness-post-harvest-orchestrator/"
        "references/detailed-instructions.md"
    )
    full_workflow = read(
        ".codex/skills/harness-full-workflow/references/detailed-instructions.md"
    )

    assert "$harness-project-wiki" in post_harvest
    assert "A missing or failed wiki output blocks ChangeSet completion." in post_harvest
    assert "./harness run wiki build" in post_harvest
    assert "project wiki creation or update after verification" in full_workflow


def test_final_only_step_is_skipped_before_last_work_item(tmp_path: Path) -> None:
    step = Step(
        id="update-project-wiki",
        kind=StepKind.AGENT,
        name="Update project wiki",
        agent_id="wiki_curator",
        metadata={"run_on_final_work_item_only": True},
    )
    context = RunContext(
        run_id="run-test",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-test/UC-001",
        metadata={"is_final_work_item": False},
    )

    result = BasicStepRunner().run(step, context)

    assert result.status == StepStatus.SKIPPED
    assert result.metadata["reason"] == "step runs only for the final work item"
