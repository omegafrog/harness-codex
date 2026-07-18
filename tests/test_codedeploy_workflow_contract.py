from pathlib import Path

import yaml


ROOT = Path(__file__).parents[1]


def test_codedeploy_step_runs_after_implementation_before_reviews() -> None:
    workflow = (ROOT / ".codex/workflow/main-steps.md").read_text(encoding="utf-8")

    assert workflow.index("| W5 |") < workflow.index("| W5a |") < workflow.index("| W6 |")
    assert "기존 workflow와\n배포 계약이 같으면 파일을 수정하지 않고 `unchanged`" in workflow


def test_changeset_contract_selects_pipeline_without_cli_option() -> None:
    contract = (ROOT / ".codex/workflow/declaration-contracts.md").read_text(encoding="utf-8")
    template = (ROOT / ".codex/workflow/changeset-template.md").read_text(encoding="utf-8")

    assert "## Deployment Pipeline" in contract
    assert "`none | codedeploy`" in contract
    assert "## Deployment Pipeline" in template


def test_codedeploy_skill_requires_explicit_workflow_invocation() -> None:
    metadata = yaml.safe_load(
        (ROOT / ".codex/skills/harness-codedeploy-pipeline/agents/openai.yaml").read_text(
            encoding="utf-8"
        )
    )

    assert metadata["policy"]["allow_implicit_invocation"] is False
