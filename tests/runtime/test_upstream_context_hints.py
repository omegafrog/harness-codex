from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.prompt import build_agent_prompt


def test_declared_upstream_context_is_visible_as_a_reading_priority(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("# AGENTS\n", encoding="utf-8")
    step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute work item",
        agent_id="implementation_executor",
        metadata={
            "stage": "implementation",
            "upstream_context": [
                {
                    "producer_step": "review-work-item-plan",
                    "artifact_path": ".harness/runs/run-001/work-items/UC-001/reviews/plan-review.md",
                    "priority": "high",
                    "purpose": "Review findings for the active plan.",
                }
            ],
        },
    )
    context = RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-001",
    )

    prompt = build_agent_prompt(
        step=step,
        context=context,
        agent_config={},
        agent_config_path=Path(".codex/agents/implementation_executor.toml"),
    )

    assert '"upstream_context"' in prompt
    assert "review-work-item-plan" in prompt
    assert "plan-review.md" in prompt
    assert '"priority": "high"' in prompt
