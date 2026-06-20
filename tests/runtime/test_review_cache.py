from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.runner import (
    AgentRunRequest,
    AgentRunResult,
    BasicStepRunner,
)


class WritingReviewAdapter:
    def __init__(self, output_path: Path, content: str | None = None) -> None:
        self.output_path = output_path
        self.content = content or "Review Status: approved\n\nNo blockers.\n"
        self.calls = 0

    def run(self, _request: AgentRunRequest) -> AgentRunResult:
        self.calls += 1
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        self.output_path.write_text(self.content, encoding="utf-8")
        return AgentRunResult(
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            metadata={
                "usage": {
                    "input_tokens": 10,
                    "cached_input_tokens": 3,
                    "output_tokens": 2,
                    "reasoning_tokens": 1,
                }
            },
        )


class FailingReviewAdapter:
    def run(self, _request: AgentRunRequest) -> AgentRunResult:
        raise AssertionError("cached approved review should skip provider call")


def test_artifact_reviewer_reuses_approved_cache_for_unchanged_inputs(
    tmp_path: Path,
) -> None:
    _write_review_runtime_files(tmp_path)
    (tmp_path / "plan.md").write_text("# Plan\n\n- [ ] Task\n", encoding="utf-8")
    first_output = tmp_path / ".harness/runs/run-first/work-items/UC-001/reviews/plan-review.md"
    first_step = _review_step(first_output)
    first_context = _context(tmp_path, "run-first")
    adapter = WritingReviewAdapter(first_output)

    first_result = BasicStepRunner(adapter).run(first_step, first_context)

    assert first_result.status == StepStatus.SUCCEEDED
    assert adapter.calls == 1
    second_output = tmp_path / ".harness/runs/run-second/work-items/UC-001/reviews/plan-review.md"
    second_result = BasicStepRunner(FailingReviewAdapter()).run(
        _review_step(second_output),
        _context(tmp_path, "run-second"),
    )

    assert second_result.status == StepStatus.SUCCEEDED
    assert second_result.metadata["review_cache_hit"] is True
    assert second_result.metadata["reviewer_usage"]["provider_calls"] == 0
    assert second_output.read_text(encoding="utf-8") == first_output.read_text(
        encoding="utf-8"
    )


def test_security_reviewer_reuses_cached_plan_for_unchanged_inputs(
    tmp_path: Path,
) -> None:
    _write_review_runtime_files(tmp_path)
    plan = tmp_path / "plan.md"
    plan.write_text("# Plan\n\n- [ ] Task\n", encoding="utf-8")
    first_step = _security_step()
    first_context = _context(tmp_path, "run-security-first")
    adapter = WritingReviewAdapter(
        plan,
        "# Plan\n\n- [ ] Task\n- [ ] Add OWASP validation task.\n",
    )

    first_result = BasicStepRunner(adapter).run(first_step, first_context)

    assert first_result.status == StepStatus.SUCCEEDED
    assert adapter.calls == 1
    assert first_result.metadata["review_cache_hit"] is False
    assert first_result.metadata["reviewer_usage"]["provider_calls"] == 1
    plan.write_text("# Plan\n\n- [ ] Task\n", encoding="utf-8")
    second_result = BasicStepRunner(FailingReviewAdapter()).run(
        _security_step(),
        _context(tmp_path, "run-security-second"),
    )

    assert second_result.status == StepStatus.SUCCEEDED
    assert second_result.metadata["review_cache_hit"] is True
    assert second_result.metadata["reviewer_usage"]["provider_calls"] == 0
    assert "Add OWASP validation task" in plan.read_text(encoding="utf-8")


def _review_step(output_path: Path) -> Step:
    return Step(
        id="review-work-item-plan",
        kind=StepKind.AGENT,
        name="Review plan",
        agent_id="artifact_reviewer",
        skill_id="harness-artifact-reviewer",
        inputs=(Path("plan.md"),),
        outputs=(output_path,),
        metadata={
            "review_gate": {
                "output": str(output_path),
                "status_label": "Review Status",
                "approved_status": "approved",
            },
        },
    )


def _security_step() -> Step:
    return Step(
        id="secure-work-item-plan",
        kind=StepKind.AGENT,
        name="Secure plan",
        agent_id="security_plan_reviewer",
        skill_id="harness-security-plan-reviewer",
        inputs=(Path("plan.md"),),
        outputs=(Path("plan.md"),),
        metadata={"stage": "security-review"},
    )


def _context(root: Path, run_id: str) -> RunContext:
    return RunContext(
        run_id=run_id,
        workflow_name="review-cache-test",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=root / ".harness/runs" / run_id / "UC-001",
        metadata={
            "change_set_id": "CHG-001",
            "active_work_item_id": "UC-001",
        },
    )


def _write_review_runtime_files(root: Path) -> None:
    agent_dir = root / ".codex/agents"
    agent_dir.mkdir(parents=True)
    (agent_dir / "artifact_reviewer.toml").write_text(
        'name = "artifact_reviewer"\n'
        'description = "Review artifacts"\n'
        'sandbox_mode = "workspace-write"\n'
        'developer_instructions = """Review the plan."""\n',
        encoding="utf-8",
    )
    (agent_dir / "security_plan_reviewer.toml").write_text(
        'name = "security_plan_reviewer"\n'
        'description = "Review plan security"\n'
        'sandbox_mode = "workspace-write"\n'
        'developer_instructions = """Patch the plan with security tasks."""\n',
        encoding="utf-8",
    )
    skill_dir = root / ".codex/skills/harness-artifact-reviewer"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: harness-artifact-reviewer\n---\n",
        encoding="utf-8",
    )
    security_skill_dir = root / ".codex/skills/harness-security-plan-reviewer"
    security_skill_dir.mkdir(parents=True)
    (security_skill_dir / "SKILL.md").write_text(
        "---\nname: harness-security-plan-reviewer\n---\n",
        encoding="utf-8",
    )
