from pathlib import Path

import pytest

from harness_codex.runtime import (
    RunContext,
    RunMode,
    RunStatus,
    RunnerEngine,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
    WorkflowValidationError,
)


class FakeStepRunner:
    def __init__(
        self,
        results_by_step_id: dict[str, StepResult] | None = None,
    ) -> None:
        self.results_by_step_id = results_by_step_id or {}
        self.executed_step_ids: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.executed_step_ids.append(step.id)

        if step.id in self.results_by_step_id:
            return self.results_by_step_id[step.id]

        return StepResult(
            step_id=step.id,
            status=StepStatus.SUCCEEDED,
            exit_code=0,
        )


def context() -> RunContext:
    return context_with_mode(RunMode.APPLY)


def context_with_mode(mode: RunMode) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="example",
        mode=mode,
        repo_root=Path("/repo"),
        workdir=Path("/repo"),
        run_dir=Path("/repo/.harness/runs/run-001"),
    )


def test_engine_runs_steps_in_dependency_order() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="validate",
                kind=StepKind.VALIDATOR,
                name="Run validation",
                needs=("implement",),
            ),
            Step(
                id="analyze",
                kind=StepKind.AGENT,
                name="Analyze plan",
            ),
            Step(
                id="implement",
                kind=StepKind.AGENT,
                name="Implement plan",
                needs=("analyze",),
            ),
        ),
    )

    fake_runner = FakeStepRunner()
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context())

    assert result.status == RunStatus.SUCCEEDED
    assert fake_runner.executed_step_ids == [
        "analyze",
        "implement",
        "validate",
    ]
    assert tuple(step_result.step_id for step_result in result.step_results) == (
        "analyze",
        "implement",
        "validate",
    )


def test_engine_stops_when_step_fails() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="analyze",
                kind=StepKind.AGENT,
                name="Analyze plan",
            ),
            Step(
                id="implement",
                kind=StepKind.AGENT,
                name="Implement plan",
                needs=("analyze",),
            ),
            Step(
                id="validate",
                kind=StepKind.VALIDATOR,
                name="Run validation",
                needs=("implement",),
            ),
        ),
    )

    fake_runner = FakeStepRunner(
        results_by_step_id={
            "implement": StepResult(
                step_id="implement",
                status=StepStatus.FAILED,
                exit_code=1,
                error="implementation failed",
            )
        }
    )
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context())

    assert result.status == RunStatus.FAILED
    assert result.failed_step_id == "implement"
    assert result.blocker == "implementation failed"
    assert fake_runner.executed_step_ids == ["analyze", "implement"]


def test_engine_stops_when_step_is_blocked() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="analyze",
                kind=StepKind.AGENT,
                name="Analyze plan",
            ),
            Step(
                id="validate",
                kind=StepKind.VALIDATOR,
                name="Run validation",
                needs=("analyze",),
            ),
        ),
    )

    fake_runner = FakeStepRunner(
        results_by_step_id={
            "analyze": StepResult(
                step_id="analyze",
                status=StepStatus.BLOCKED,
                error="missing plan.md",
            )
        }
    )
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context())

    assert result.status == RunStatus.BLOCKED
    assert result.failed_step_id == "analyze"
    assert result.blocker == "missing plan.md"
    assert fake_runner.executed_step_ids == ["analyze"]


def test_plan_rejects_duplicate_step_ids() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.PLAN,
        steps=(
            Step(
                id="same",
                kind=StepKind.AGENT,
                name="First",
            ),
            Step(
                id="same",
                kind=StepKind.VALIDATOR,
                name="Second",
            ),
        ),
    )

    engine = RunnerEngine(FakeStepRunner())

    with pytest.raises(WorkflowValidationError, match="Duplicate step id"):
        engine.plan(workflow)


def test_plan_rejects_unknown_dependency() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.PLAN,
        steps=(
            Step(
                id="validate",
                kind=StepKind.VALIDATOR,
                name="Validate",
                needs=("missing",),
            ),
        ),
    )

    engine = RunnerEngine(FakeStepRunner())

    with pytest.raises(WorkflowValidationError, match="depends on unknown step"):
        engine.plan(workflow)


def test_plan_rejects_cyclic_dependencies() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.PLAN,
        steps=(
            Step(
                id="a",
                kind=StepKind.AGENT,
                name="A",
                needs=("c",),
            ),
            Step(
                id="b",
                kind=StepKind.AGENT,
                name="B",
                needs=("a",),
            ),
            Step(
                id="c",
                kind=StepKind.AGENT,
                name="C",
                needs=("b",),
            ),
        ),
    )

    engine = RunnerEngine(FakeStepRunner())

    with pytest.raises(WorkflowValidationError, match="cyclic"):
        engine.plan(workflow)


def test_plan_returns_execution_plan_without_running_steps() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.PLAN,
        steps=(
            Step(
                id="validate",
                kind=StepKind.VALIDATOR,
                name="Validate",
                needs=("analyze",),
            ),
            Step(
                id="analyze",
                kind=StepKind.AGENT,
                name="Analyze",
            ),
        ),
    )

    fake_runner = FakeStepRunner()
    engine = RunnerEngine(fake_runner)

    plan = engine.plan(workflow)

    assert plan.step_ids() == ("analyze", "validate")
    assert fake_runner.executed_step_ids == []


def test_run_in_plan_mode_records_plan_without_running_steps() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="analyze",
                kind=StepKind.AGENT,
                name="Analyze",
            ),
            Step(
                id="validate",
                kind=StepKind.VALIDATOR,
                name="Validate",
                needs=("analyze",),
            ),
        ),
    )
    fake_runner = FakeStepRunner()
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context_with_mode(RunMode.PLAN))

    assert result.status == RunStatus.SUCCEEDED
    assert result.mode == RunMode.PLAN
    assert result.metadata["mode"] == "plan"
    assert result.metadata["planned_steps"] == ("analyze", "validate")
    assert result.metadata["side_effects"] is False
    assert fake_runner.executed_step_ids == []
    assert tuple(step_result.status for step_result in result.step_results) == (
        StepStatus.SKIPPED,
        StepStatus.SKIPPED,
    )


def test_run_in_preview_mode_records_preview_without_running_steps() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="implement",
                kind=StepKind.AGENT,
                name="Implement",
            ),
        ),
    )
    fake_runner = FakeStepRunner()
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context_with_mode(RunMode.PREVIEW))

    assert result.status == RunStatus.SUCCEEDED
    assert result.mode == RunMode.PREVIEW
    assert result.metadata["mode"] == "preview"
    assert result.metadata["planned_steps"] == ("implement",)
    assert result.metadata["side_effects"] is False
    assert fake_runner.executed_step_ids == []
    assert result.step_results[0].metadata["would_run"] is True


def test_run_in_apply_mode_executes_steps_and_records_mode() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="implement",
                kind=StepKind.AGENT,
                name="Implement",
            ),
        ),
    )
    fake_runner = FakeStepRunner()
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context_with_mode(RunMode.APPLY))

    assert result.status == RunStatus.SUCCEEDED
    assert result.mode == RunMode.APPLY
    assert result.metadata["mode"] == "apply"
    assert result.metadata["side_effects"] is True
    assert fake_runner.executed_step_ids == ["implement"]
