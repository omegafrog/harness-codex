from pathlib import Path

from harness_codex.runtime.workflows import load_workflow_file


REPO_ROOT = Path(__file__).resolve().parents[2]
HARVEST_WORKFLOW_PATH = REPO_ROOT / ".harness/workflows/harvest-workflow.yaml"


def test_harvest_agent_outputs_are_the_only_stage_write_contract() -> None:
    workflow = load_workflow_file(HARVEST_WORKFLOW_PATH)
    steps = {step.id: step for step in workflow.steps}

    assert steps["harvest-requirements"].outputs == (
        Path("docs/design/요구사항.md"),
    )
    assert steps["harvest-ubiquitous-language"].outputs == (Path("context.md"),)
    assert steps["harvest-use-cases"].outputs == (
        Path("docs/design/유스케이스.md"),
        Path("docs/use-cases"),
    )

    for step_id in (
        "harvest-requirements",
        "harvest-ubiquitous-language",
        "harvest-use-cases",
    ):
        assert "bootstrap_outputs" not in steps[step_id].metadata
