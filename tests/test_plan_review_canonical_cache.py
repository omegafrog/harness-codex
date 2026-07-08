from __future__ import annotations

import hashlib
from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.runner import BasicStepRunner, _review_input_hash
from harness_codex.runtime.xml_handoff import write_handoff


class _FailingAdapter:
    def run(self, request):  # pragma: no cover - 실패 시 테스트가 바로 깨진다.
        raise AssertionError("canonical plan review cache should skip reviewer agent")


class _ApprovingAdapter:
    def run(self, request):
        output = request.context.repo_root / request.step.outputs[0]
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("# 계획 리뷰\n\nReview Status: approved\n", encoding="utf-8")
        from harness_codex.runtime.runner import AgentRunResult

        return AgentRunResult(status=StepStatus.SUCCEEDED, exit_code=0, metadata={"provider": "test"})


def test_review_work_item_plan_uses_canonical_approval_when_hash_matches(tmp_path: Path) -> None:
    (tmp_path / ".codex/agents").mkdir(parents=True)
    agent_config = tmp_path / ".codex/agents/artifact_reviewer.toml"
    agent_config.write_text("model = \"test\"\n", encoding="utf-8")
    plan_path = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text("# 구현 계획\n\n## 집중 검증\n- [ ] VERIFY-001: `true`\n", encoding="utf-8")
    approval_path = tmp_path / "docs/plans/active/UC-001/plan-review.xml"
    context = RunContext(
        run_id="run-new",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-new",
        metadata={"active_work_item_id": "UC-001", "change_set_id": "CHG-001"},
    )
    step = Step(
        id="review-work-item-plan",
        kind=StepKind.AGENT,
        name="review",
        agent_id="artifact_reviewer",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        metadata={
            "review_gate": {
                "output": ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/reviews/plan-review.md",
                "status_label": "Review Status",
                "approved_status": "approved",
            }
        },
    )
    input_hash = _review_input_hash(step, context, agent_config, None)
    write_handoff(
        approval_path,
        "gate-verdict",
        {
            "schema_version": 1,
            "gate_id": "plan-review",
            "status": "approved",
            "source_path": ".harness/runs/run-old/work-items/UC-001/reviews/plan-review.md",
            "input_hash": input_hash,
            "plan_path": "docs/plans/active/UC-001/plan.md",
            "plan_sha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
            "work_item_id": "UC-001",
        },
    )

    result = BasicStepRunner(agent_adapter=_FailingAdapter()).run(step, context)

    assert result.status is StepStatus.SUCCEEDED
    assert result.metadata["review_cache_source"] == "canonical-plan-review"
    review = tmp_path / ".harness/runs/run-new/work-items/UC-001/reviews/plan-review.md"
    assert "Review Status: approved" in review.read_text(encoding="utf-8")


def test_review_work_item_plan_cache_survives_isolated_worktree_runs(tmp_path: Path) -> None:
    source = tmp_path / "source"
    worktree_one = tmp_path / "worktree-one"
    worktree_two = tmp_path / "worktree-two"
    for root in (source, worktree_one, worktree_two):
        (root / ".codex/agents").mkdir(parents=True)
        (root / ".codex/agents/artifact_reviewer.toml").write_text("model = \"test\"\n", encoding="utf-8")
        plan = root / "docs/plans/active/UC-001/plan.md"
        plan.parent.mkdir(parents=True)
        plan.write_text("# 구현 계획\n\n## 집중 검증\n- [ ] VERIFY-001: `true`\n", encoding="utf-8")
    (source / ".harness/runs").mkdir(parents=True)
    for worktree in (worktree_one, worktree_two):
        (worktree / ".harness").mkdir()
        (worktree / ".harness/runs").symlink_to(source / ".harness/runs", target_is_directory=True)

    def context(root: Path, run_id: str) -> RunContext:
        return RunContext(
            run_id=run_id,
            workflow_name="workflow",
            mode=RunMode.APPLY,
            repo_root=root,
            workdir=root,
            run_dir=root / ".harness/runs" / run_id / "work-items/UC-001",
            metadata={"active_work_item_id": "UC-001", "change_set_id": "CHG-001"},
        )

    def step(run_id: str) -> Step:
        output = Path(f".harness/runs/{run_id}/work-items/UC-001/reviews/plan-review.md")
        return Step(
            id="review-work-item-plan",
            kind=StepKind.AGENT,
            name="review",
            agent_id="artifact_reviewer",
            inputs=(Path("docs/plans/active/UC-001/plan.md"),),
            outputs=(output,),
            metadata={
                "review_gate": {
                    "output": str(output),
                    "status_label": "Review Status",
                    "approved_status": "approved",
                }
            },
        )

    first = BasicStepRunner(agent_adapter=_ApprovingAdapter()).run(step("run-one"), context(worktree_one, "run-one"))
    assert first.status is StepStatus.SUCCEEDED
    assert (source / "docs/plans/active/UC-001/plan-review.xml").is_file()
    assert (source / ".harness/review-cache").is_dir()

    second = BasicStepRunner(agent_adapter=_FailingAdapter()).run(step("run-two"), context(worktree_two, "run-two"))

    assert second.status is StepStatus.SUCCEEDED
    assert second.metadata["review_cache_source"] == "canonical-plan-review"
    restored = source / ".harness/runs/run-two/work-items/UC-001/reviews/plan-review.md"
    assert "Review Status: approved" in restored.read_text(encoding="utf-8")
