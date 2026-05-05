from pathlib import Path

import pytest

from harness_codex.runtime import (
    FailureKind,
    HARNESS_FULL_WORKFLOW,
    HARNESS_PLAN_EXECUTOR_WORKFLOW,
    RunContext,
    RunMode,
    RunResult,
    RunStatus,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)


def test_harness_plan_executor_workflow_models_current_skill_flow() -> None:
    workflow = HARNESS_PLAN_EXECUTOR_WORKFLOW

    assert workflow.name == "harness-plan-executor"
    assert workflow.mode == RunMode.APPLY

    assert workflow.step_ids() == (
        "load-active-plan",
        "delegate-implementation",
        "inspect-executor-result",
        "run-final-verification",
        "classify-verification-failure",
        "record-remediation-or-blocker",
        "complete-plan",
    )


def test_delegate_implementation_step_targets_implementation_executor() -> None:
    step = HARNESS_PLAN_EXECUTOR_WORKFLOW.step_by_id("delegate-implementation")

    assert step.kind == StepKind.AGENT
    assert step.agent_id == "implementation_executor"
    assert step.needs == ("load-active-plan",)
    assert Path(".codex/agents/implementation_executor.toml") in step.inputs


def test_final_verification_step_keeps_typical_commands_as_metadata() -> None:
    step = HARNESS_PLAN_EXECUTOR_WORKFLOW.step_by_id("run-final-verification")

    assert step.kind == StepKind.VALIDATOR
    assert "./gradlew build" in step.metadata["typical_commands"]
    assert "./gradlew test" in step.metadata["typical_commands"]


def test_workflow_step_by_id_raises_for_unknown_step() -> None:
    with pytest.raises(KeyError):
        HARNESS_PLAN_EXECUTOR_WORKFLOW.step_by_id("unknown-step")


def test_run_context_carries_runtime_paths() -> None:
    context = RunContext(
        run_id="run-001",
        workflow_name="harness-plan-executor",
        mode=RunMode.APPLY,
        repo_root=Path("/repo"),
        workdir=Path("/repo"),
        run_dir=Path("/repo/.harness/runs/run-001"),
    )

    assert context.run_id == "run-001"
    assert context.active_plan_path == Path("docs/plans/active/plan.md")
    assert context.architecture_path == Path("ARCHITECTURE.md")


def test_step_result_successful_property() -> None:
    success = StepResult(
        step_id="run-final-verification",
        status=StepStatus.SUCCEEDED,
        exit_code=0,
    )
    failure = StepResult(
        step_id="run-final-verification",
        status=StepStatus.FAILED,
        exit_code=1,
        error="build failed",
        failure_kind=FailureKind.IMPLEMENTATION,
    )

    assert success.successful is True
    assert failure.successful is False


def test_run_result_can_represent_blocker_without_losing_step_results() -> None:
    result = RunResult(
        run_id="run-001",
        status=RunStatus.BLOCKED,
        failed_step_id="run-final-verification",
        blocker="missing external service",
        step_results=(
            StepResult(
                step_id="load-active-plan",
                status=StepStatus.SUCCEEDED,
            ),
            StepResult(
                step_id="run-final-verification",
                status=StepStatus.BLOCKED,
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
            ),
        ),
    )

    assert result.status == RunStatus.BLOCKED
    assert result.failed_step_id == "run-final-verification"
    assert len(result.step_results) == 2


def test_custom_workflow_can_represent_multiple_steps_without_side_effects() -> None:
    workflow = Workflow(
        name="example",
        mode=RunMode.PLAN,
        steps=(
            Step(
                id="analyze",
                kind=StepKind.AGENT,
                name="Analyze repository",
                agent_id="implementation_executor",
            ),
            Step(
                id="validate",
                kind=StepKind.VALIDATOR,
                name="Run tests",
                needs=("analyze",),
                command="./gradlew test",
            ),
        ),
    )

    assert workflow.step_ids() == ("analyze", "validate")
    assert workflow.step_by_id("validate").needs == ("analyze",)


def test_harness_full_workflow_models_top_level_harness_lifecycle() -> None:
    workflow = HARNESS_FULL_WORKFLOW

    assert workflow.name == "harness-full-workflow"
    assert workflow.mode == RunMode.APPLY

    assert workflow.step_ids() == (
        "harvest-use-cases",
        "orchestrator-start",
        "oracle-generate-plan",
        "planner-refine-active-plan",
        "executor-implement-plan",
        "run-verification",
        "classify-verification-result",
        "record-remediation-and-repeat",
        "record-upstream-blocker",
        "record-environment-blocker",
        "complete-plan",
    )


def test_harness_full_workflow_starts_with_harvester_gate() -> None:
    step = HARNESS_FULL_WORKFLOW.step_by_id("harvest-use-cases")

    assert step.kind == StepKind.AGENT
    assert step.agent_id == "use_case_harvester"
    assert step.needs == ()
    assert step.metadata["stage"] == "harvester"
    assert step.metadata["gate"] == "user_ok_required"


def test_harness_full_workflow_orchestrates_oracle_planner_executor_verification() -> (
    None
):
    oracle = HARNESS_FULL_WORKFLOW.step_by_id("oracle-generate-plan")
    planner = HARNESS_FULL_WORKFLOW.step_by_id("planner-refine-active-plan")
    executor = HARNESS_FULL_WORKFLOW.step_by_id("executor-implement-plan")
    verification = HARNESS_FULL_WORKFLOW.step_by_id("run-verification")

    assert oracle.kind == StepKind.AGENT
    assert oracle.agent_id == "oracle"
    assert oracle.needs == ("orchestrator-start",)

    assert planner.kind == StepKind.AGENT
    assert planner.agent_id == "planner"
    assert planner.needs == ("oracle-generate-plan",)

    assert executor.kind == StepKind.AGENT
    assert executor.agent_id == "implementation_executor"
    assert executor.needs == ("planner-refine-active-plan",)

    assert verification.kind == StepKind.VALIDATOR
    assert verification.needs == ("executor-implement-plan",)
    assert "./gradlew build" in verification.metadata["typical_commands"]
    assert "./gradlew test" in verification.metadata["typical_commands"]


def test_harness_full_workflow_records_repeat_loop_intent() -> None:
    decision = HARNESS_FULL_WORKFLOW.step_by_id("classify-verification-result")
    remediation = HARNESS_FULL_WORKFLOW.step_by_id("record-remediation-and-repeat")

    assert decision.kind == StepKind.DECISION
    assert decision.needs == ("run-verification",)
    assert (
        decision.metadata["on_implementation_failure"]
        == "record-remediation-and-repeat"
    )

    assert remediation.kind == StepKind.RECORD
    assert remediation.needs == ("classify-verification-result",)
    assert remediation.metadata["loop_target"] == "executor-implement-plan"
    assert remediation.metadata["loop_until"] == "verification_passes_or_blocker"


def test_harness_full_workflow_records_blocker_paths() -> None:
    upstream = HARNESS_FULL_WORKFLOW.step_by_id("record-upstream-blocker")
    environment = HARNESS_FULL_WORKFLOW.step_by_id("record-environment-blocker")

    assert upstream.kind == StepKind.RECORD
    assert upstream.metadata["stop_reason"] == "upstream_design_blocker"

    assert environment.kind == StepKind.RECORD
    assert environment.metadata["stop_reason"] == "environment_blocker"


def test_harness_full_workflow_records_completion_path() -> None:
    complete = HARNESS_FULL_WORKFLOW.step_by_id("complete-plan")

    assert complete.kind == StepKind.GIT
    assert complete.needs == ("classify-verification-result",)
    assert (
        complete.metadata["condition"]
        == "all_tasks_checked_and_all_verification_passed"
    )
    assert Path("docs/plans/active/plan.md") in complete.inputs
    assert Path("docs/plans/completed/plan.md") in complete.outputs
