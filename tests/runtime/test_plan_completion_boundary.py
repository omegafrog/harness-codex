from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.runner import BasicStepRunner


def test_work_item_workflow_blocks_plan_move_from_non_completion_git_step(
    tmp_path: Path,
) -> None:
    active = tmp_path / "docs/plans/active/UC-001/plan.md"
    active.parent.mkdir(parents=True, exist_ok=True)
    active.write_text("# Plan\n", encoding="utf-8")
    completed = Path("docs/plans/completed/UC-001/plan.md")
    context = RunContext(
        run_id="run-001",
        workflow_name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-001",
    )
    step = Step(
        id="archive-plan-early",
        kind=StepKind.GIT,
        name="Archive plan early",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        outputs=(completed,),
    )

    result = BasicStepRunner().run(step, context)

    assert result.status == StepStatus.BLOCKED
    assert "only `complete-work-item-plan` may move" in (result.error or "")
    assert active.exists()
    assert not (tmp_path / completed).exists()
