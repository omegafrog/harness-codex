from pathlib import Path

from harness_codex.runtime import (
    FailureKind,
    RunContext,
    RunMode,
    RunStatus,
    Step,
    StepResult,
    StepStatus,
    WorkItemLoopRunner,
)
from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    ChangeSet,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.workflows import load_named_workflow


class FakeStepRunner:
    def __init__(self, results: dict[str, list[StepResult]] | None = None) -> None:
        self.results = results or {}
        self.steps: list[Step] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.steps.append(step)
        if step.id in self.results and self.results[step.id]:
            return self.results[step.id].pop(0)
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs/run-001",
    )


def change_set() -> ChangeSet:
    return ChangeSet(
        change_set_id="CHG-001",
        title="테스트 변경",
        path=Path("docs/changes/active/CHG-001.md"),
    )


def scope() -> PlanningInputScope:
    use_case = AffectedUseCase(
        uc_id="UC-001",
        name="결제 승인",
        impact_type="update",
        slice_path=Path("docs/use-cases/UC-001"),
    )
    return PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=use_case,
        planner_inputs=(
            Path("docs/changes/active/CHG-001.md"),
            Path("docs/use-cases/UC-001/e2e-goal.md"),
        ),
        executor_inputs=(
            Path("docs/plans/active/UC-001/plan.md"),
            Path("docs/changes/active/CHG-001.md"),
        ),
        e2e_goal_path=Path("docs/use-cases/UC-001/e2e-goal.md"),
        work_item_id="UC-001",
        work_item_type=WorkItemType.USE_CASE,
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
        verification_goal_path=Path("docs/use-cases/UC-001/e2e-goal.md"),
    )


def workflow():
    return load_named_workflow("changeset-use-case-workflow")


def test_work_item_loop_materializes_inputs_and_outputs(tmp_path: Path) -> None:
    fake_runner = FakeStepRunner()
    runner = WorkItemLoopRunner(step_runner=fake_runner, workflow=workflow())

    result = runner.run(
        change_set=change_set(),
        scopes=(scope(),),
        context=context(tmp_path),
    )

    assert result.status == RunStatus.SUCCEEDED
    assert result.completed_work_items == ("UC-001",)
    assert [step.id for step in fake_runner.steps] == [
        "load-change-set",
        "plan-work-item",
        "execute-work-item",
        "verify-work-item",
        "classify-verification-result",
        "complete-work-item-plan",
    ]

    plan_step = fake_runner.steps[1]
    assert plan_step.inputs == (
        Path("docs/changes/active/CHG-001.md"),
        Path("docs/use-cases/UC-001/e2e-goal.md"),
    )
    assert plan_step.outputs == (Path("docs/plans/active/UC-001/plan.md"),)

    execute_step = fake_runner.steps[2]
    assert execute_step.inputs == (
        Path("docs/plans/active/UC-001/plan.md"),
        Path("docs/changes/active/CHG-001.md"),
    )

    complete_step = fake_runner.steps[-1]
    assert complete_step.outputs == (Path("docs/plans/completed/UC-001/plan.md"),)


def test_work_item_loop_retries_implementation_failure(tmp_path: Path) -> None:
    plan_path = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text("# Plan\n", encoding="utf-8")
    fake_runner = FakeStepRunner(
        {
            "verify-work-item": [
                StepResult(
                    step_id="verify-work-item",
                    status=StepStatus.FAILED,
                    error="unit test failed",
                    failure_kind=FailureKind.IMPLEMENTATION,
                ),
                StepResult(
                    step_id="verify-work-item",
                    status=StepStatus.SUCCEEDED,
                ),
            ]
        }
    )
    runner = WorkItemLoopRunner(step_runner=fake_runner, workflow=workflow())

    result = runner.run(
        change_set=change_set(),
        scopes=(scope(),),
        context=context(tmp_path),
    )

    item_result = result.item_results[0]
    assert item_result.status == RunStatus.SUCCEEDED
    assert item_result.retry_count == 1
    assert [step.id for step in fake_runner.steps].count("execute-work-item") == 2
    assert [step.id for step in fake_runner.steps].count("verify-work-item") == 2

    remediation = (
        tmp_path / ".harness/runs/run-001/work-items/UC-001/remediation/1.md"
    ).read_text(encoding="utf-8")
    assert "unit test failed" in remediation
    assert "재실행 계획 1" in plan_path.read_text(encoding="utf-8")


def test_work_item_loop_stops_on_environment_blocker(tmp_path: Path) -> None:
    fake_runner = FakeStepRunner(
        {
            "verify-work-item": [
                StepResult(
                    step_id="verify-work-item",
                    status=StepStatus.BLOCKED,
                    error="missing service",
                    failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                ),
            ]
        }
    )
    runner = WorkItemLoopRunner(step_runner=fake_runner, workflow=workflow())

    result = runner.run(
        change_set=change_set(),
        scopes=(scope(),),
        context=context(tmp_path),
    )

    assert result.status == RunStatus.BLOCKED
    assert result.blocked_work_items == ("UC-001",)
    assert [step.id for step in fake_runner.steps].count("execute-work-item") == 1
    assert result.item_results[0].blocker == "missing service"
