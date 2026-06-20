from pathlib import Path

import pytest

from harness_codex.runtime import (
    FailureKind,
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
        self.contexts_by_step_id: dict[str, list[RunContext]] = {}

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.executed_step_ids.append(step.id)
        self.contexts_by_step_id.setdefault(step.id, []).append(context)

        if step.id in self.results_by_step_id:
            result = self.results_by_step_id[step.id]
            if isinstance(result, list):
                return result.pop(0)
            return result

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


def test_engine_exposes_phase_metrics_from_step_metadata() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="execute-work-item",
                kind=StepKind.AGENT,
                name="Execute",
            ),
        ),
    )
    fake_runner = FakeStepRunner(
        {
            "execute-work-item": StepResult(
                step_id="execute-work-item",
                status=StepStatus.SUCCEEDED,
                metadata={
                    "phase_metrics": {
                        "focused-tests": {
                            "command_count": 2,
                            "input_tokens": 10,
                            "cached_input_tokens": 5,
                            "output_tokens": 3,
                            "reasoning_tokens": 1,
                        }
                    }
                },
            )
        }
    )

    result = RunnerEngine(fake_runner).run(workflow, context())

    assert result.metadata["phase_metrics"] == (
        {
            "step_id": "execute-work-item",
            "phase_metrics": {
                "focused-tests": {
                    "command_count": 2,
                    "input_tokens": 10,
                    "cached_input_tokens": 5,
                    "output_tokens": 3,
                    "reasoning_tokens": 1,
                }
            },
        },
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


def test_engine_blocks_executor_when_reviewer_rejects_artifact() -> None:
    workflow = Workflow(
        name="review-gated",
        mode=RunMode.APPLY,
        steps=(
            Step(id="plan", kind=StepKind.AGENT, name="Plan"),
            Step(
                id="review-plan",
                kind=StepKind.AGENT,
                name="Review plan",
                needs=("plan",),
                metadata={"review_gate": {"approved_status": "approved"}},
            ),
            Step(
                id="execute",
                kind=StepKind.AGENT,
                name="Execute plan",
                needs=("review-plan",),
            ),
        ),
    )
    fake_runner = FakeStepRunner(
        results_by_step_id={
            "review-plan": StepResult(
                step_id="review-plan",
                status=StepStatus.BLOCKED,
                error="review gate status is `rejected`, expected `approved`",
            )
        }
    )
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context())

    assert result.status == RunStatus.BLOCKED
    assert result.failed_step_id == "review-plan"
    assert result.blocker == "review gate status is `rejected`, expected `approved`"
    assert fake_runner.executed_step_ids == ["plan", "review-plan"]


def test_engine_loops_implementation_failure_through_remediation() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(id="plan", kind=StepKind.AGENT, name="Plan"),
            Step(
                id="execute",
                kind=StepKind.AGENT,
                name="Execute",
                needs=("plan",),
            ),
            Step(
                id="verify",
                kind=StepKind.VALIDATOR,
                name="Verify",
                needs=("execute",),
            ),
            Step(
                id="classify",
                kind=StepKind.DECISION,
                name="Classify",
                needs=("verify",),
            ),
            Step(
                id="remediate",
                kind=StepKind.RECORD,
                name="Remediate",
                needs=("classify",),
                metadata={"loop_target": "execute", "max_retry_count": 2},
            ),
            Step(
                id="complete",
                kind=StepKind.RECORD,
                name="Complete",
                needs=("classify",),
            ),
        ),
    )
    fake_runner = FakeStepRunner(
        results_by_step_id={
            "verify": [
                StepResult(
                    step_id="verify",
                    status=StepStatus.FAILED,
                    error="missing branch",
                    failure_kind=FailureKind.IMPLEMENTATION,
                ),
                StepResult(step_id="verify", status=StepStatus.SUCCEEDED),
            ],
        }
    )

    result = RunnerEngine(fake_runner).run(workflow, context())

    assert result.status == RunStatus.SUCCEEDED
    assert result.retry_count == 1
    assert fake_runner.executed_step_ids == [
        "plan",
        "execute",
        "verify",
        "classify",
        "remediate",
        "execute",
        "verify",
        "classify",
        "complete",
    ]


def test_engine_restarts_scope_conflict_from_plan_work_item() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(id="plan-work-item", kind=StepKind.AGENT, name="Plan"),
            Step(
                id="secure-work-item-plan",
                kind=StepKind.AGENT,
                name="Secure",
                needs=("plan-work-item",),
            ),
            Step(
                id="review-work-item-plan",
                kind=StepKind.AGENT,
                name="Review",
                needs=("secure-work-item-plan",),
            ),
            Step(
                id="execute-work-item",
                kind=StepKind.AGENT,
                name="Execute",
                needs=("review-work-item-plan",),
            ),
            Step(
                id="verify-work-item",
                kind=StepKind.VALIDATOR,
                name="Verify",
                needs=("execute-work-item",),
            ),
        ),
    )
    fake_runner = FakeStepRunner(
        results_by_step_id={
            "execute-work-item": [
                StepResult(
                    step_id="execute-work-item",
                    status=StepStatus.BLOCKED,
                    error="scope diff blocked unexpected files: src/app.py",
                    failure_kind=FailureKind.SCOPE_CONFLICT,
                ),
                StepResult(step_id="execute-work-item", status=StepStatus.SUCCEEDED),
            ],
        }
    )

    result = RunnerEngine(fake_runner).run(workflow, context())

    assert result.status == RunStatus.SUCCEEDED
    assert result.retry_count == 1
    assert fake_runner.executed_step_ids == [
        "plan-work-item",
        "secure-work-item-plan",
        "review-work-item-plan",
        "execute-work-item",
        "plan-work-item",
        "secure-work-item-plan",
        "review-work-item-plan",
        "execute-work-item",
        "verify-work-item",
    ]
    retry_context = fake_runner.contexts_by_step_id["plan-work-item"][1]
    assert retry_context.metadata["runtime_failed_step_id"] == "execute-work-item"
    assert retry_context.metadata["runtime_failure_kind"] == "scope_conflict"
    assert "scope diff blocked" in retry_context.metadata["runtime_failure_error"]


def test_engine_restarts_rejected_plan_review_from_plan_work_item() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(id="plan-work-item", kind=StepKind.AGENT, name="Plan"),
            Step(
                id="secure-work-item-plan",
                kind=StepKind.AGENT,
                name="Secure",
                needs=("plan-work-item",),
            ),
            Step(
                id="review-work-item-plan",
                kind=StepKind.AGENT,
                name="Review",
                needs=("secure-work-item-plan",),
            ),
            Step(
                id="execute-work-item",
                kind=StepKind.AGENT,
                name="Execute",
                needs=("review-work-item-plan",),
            ),
        ),
    )
    fake_runner = FakeStepRunner(
        results_by_step_id={
            "review-work-item-plan": [
                StepResult(
                    step_id="review-work-item-plan",
                    status=StepStatus.BLOCKED,
                    error="review gate status is `rejected`, expected `approved`",
                    failure_kind=FailureKind.PLAN_REVIEW_REJECTED,
                ),
                StepResult(
                    step_id="review-work-item-plan",
                    status=StepStatus.SUCCEEDED,
                ),
            ],
        }
    )

    result = RunnerEngine(fake_runner).run(workflow, context())

    assert result.status == RunStatus.SUCCEEDED
    assert result.retry_count == 1
    assert fake_runner.executed_step_ids == [
        "plan-work-item",
        "secure-work-item-plan",
        "review-work-item-plan",
        "plan-work-item",
        "secure-work-item-plan",
        "review-work-item-plan",
        "execute-work-item",
    ]
    retry_context = fake_runner.contexts_by_step_id["plan-work-item"][1]
    assert retry_context.metadata["runtime_failed_step_id"] == "review-work-item-plan"
    assert retry_context.metadata["runtime_failure_kind"] == "plan_review_rejected"
    assert "review gate status" in retry_context.metadata["runtime_failure_error"]


def test_engine_blocks_non_implementation_failure_without_remediation() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(id="plan", kind=StepKind.AGENT, name="Plan"),
            Step(
                id="execute",
                kind=StepKind.AGENT,
                name="Execute",
                needs=("plan",),
            ),
            Step(
                id="verify",
                kind=StepKind.VALIDATOR,
                name="Verify",
                needs=("execute",),
            ),
            Step(
                id="classify",
                kind=StepKind.DECISION,
                name="Classify",
                needs=("verify",),
            ),
            Step(
                id="remediate",
                kind=StepKind.RECORD,
                name="Remediate",
                needs=("classify",),
                metadata={"loop_target": "execute"},
            ),
            Step(
                id="complete",
                kind=StepKind.RECORD,
                name="Complete",
                needs=("classify",),
            ),
        ),
    )
    fake_runner = FakeStepRunner(
        results_by_step_id={
            "verify": StepResult(
                step_id="verify",
                status=StepStatus.FAILED,
                error="database unavailable",
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
            ),
        }
    )

    result = RunnerEngine(fake_runner).run(workflow, context())

    assert result.status == RunStatus.BLOCKED
    assert result.failure_kind == FailureKind.ENVIRONMENT_BLOCKER
    assert result.retry_count == 0
    assert fake_runner.executed_step_ids == [
        "plan",
        "execute",
        "verify",
        "classify",
    ]


def test_engine_records_decision_metadata() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(id="verify", kind=StepKind.VALIDATOR, name="Verify"),
            Step(
                id="classify",
                kind=StepKind.DECISION,
                name="Classify",
                needs=("verify",),
            ),
        ),
    )
    fake_runner = FakeStepRunner(
        results_by_step_id={
            "classify": StepResult(
                step_id="classify",
                status=StepStatus.SUCCEEDED,
                metadata={
                    "decision": {
                        "classifier": "verification_result",
                        "decision": "VERIFICATION_PASSED",
                        "route": "complete",
                        "blocked": False,
                    }
                },
            ),
        }
    )

    result = RunnerEngine(fake_runner).run(workflow, context())

    assert result.status == RunStatus.SUCCEEDED
    assert result.metadata["decisions"] == (
        {
            "step_id": "classify",
            "classifier": "verification_result",
            "decision": "VERIFICATION_PASSED",
            "route": "complete",
            "blocked": False,
        },
    )


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


def test_run_in_plan_mode_blocks_mutating_command_before_dry_run() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="mutate",
                kind=StepKind.SHELL,
                name="Mutate file",
                command="touch changed.txt",
            ),
        ),
    )
    fake_runner = FakeStepRunner()
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context_with_mode(RunMode.PLAN))

    assert result.status == RunStatus.BLOCKED
    assert result.failed_step_id == "mutate"
    assert result.metadata["policy_decisions"][0]["rule_id"] == (
        "plan-mode-mutation"
    )
    assert fake_runner.executed_step_ids == []


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


def test_engine_blocks_shell_command_when_policy_denies_it() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="dangerous",
                kind=StepKind.SHELL,
                name="Dangerous command",
                command="rm -rf /",
            ),
        ),
    )
    fake_runner = FakeStepRunner()
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context_with_mode(RunMode.APPLY))

    assert result.status == RunStatus.BLOCKED
    assert result.failed_step_id == "dangerous"
    assert result.step_results[0].metadata["policy_decision"]["effect"] == "deny"
    assert result.metadata["policy_decisions"][0]["rule_id"] == "deny-rm-rf-root"
    assert fake_runner.executed_step_ids == []


def test_engine_records_allowed_command_policy_decision() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="validate",
                kind=StepKind.VALIDATOR,
                name="Run tests",
                command="pytest tests/runtime",
            ),
        ),
    )
    fake_runner = FakeStepRunner()
    engine = RunnerEngine(fake_runner)

    result = engine.run(workflow, context_with_mode(RunMode.APPLY))

    assert result.status == RunStatus.SUCCEEDED
    assert result.step_results[0].metadata["policy_decision"]["effect"] == "allow"
    assert result.metadata["policy_decisions"][0]["effect"] == "allow"
    assert fake_runner.executed_step_ids == ["validate"]
