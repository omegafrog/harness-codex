from pathlib import Path

import pytest

from harness_codex.runtime import (
    FailureKind,
    HARNESS_FULL_WORKFLOW,
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


def test_workflow_step_by_id_raises_for_unknown_step() -> None:
    with pytest.raises(KeyError):
        HARNESS_FULL_WORKFLOW.step_by_id("unknown-step")


def test_run_context_carries_runtime_paths() -> None:
    context = RunContext(
        run_id="run-001",
        workflow_name="harness-full-workflow",
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
        "harvest-requirements",
        "harvest-ubiquitous-language",
        "harvest-use-cases",
        "capture-implementation-intent",
        "create-change-set",
        "identify-affected-use-cases",
        "storm-affected-use-case",
        "design-affected-use-case",
        "planner-create-use-case-plan",
        "executor-implement-use-case-plan",
        "verifier-run-use-case-e2e",
        "classify-use-case-verification-result",
        "revise-use-case-plan-and-repeat",
        "record-use-case-blocker",
        "complete-use-case-plan",
        "complete-change-set",
    )


def test_harness_full_workflow_starts_with_harvest_then_change_set_intake() -> None:
    requirements = HARNESS_FULL_WORKFLOW.step_by_id("harvest-requirements")
    language = HARNESS_FULL_WORKFLOW.step_by_id("harvest-ubiquitous-language")
    use_cases = HARNESS_FULL_WORKFLOW.step_by_id("harvest-use-cases")
    capture = HARNESS_FULL_WORKFLOW.step_by_id("capture-implementation-intent")
    change_set = HARNESS_FULL_WORKFLOW.step_by_id("create-change-set")
    affected = HARNESS_FULL_WORKFLOW.step_by_id("identify-affected-use-cases")

    assert requirements.kind == StepKind.AGENT
    assert requirements.agent_id == "requirements_interviewer"
    assert requirements.needs == ()
    assert requirements.metadata["scope"] == "canonical_requirements"
    assert requirements.outputs == (Path("docs/design/요구사항.md"),)

    assert language.kind == StepKind.AGENT
    assert language.agent_id == "ubiquitous_language_reviewer"
    assert language.skill_id == "harness-ubiquitous-language"
    assert language.needs == ("harvest-requirements",)
    assert language.inputs == (Path("docs/design/요구사항.md"),)
    assert language.outputs == (Path("context.md"),)
    assert language.metadata["scope"] == "canonical_language"

    assert use_cases.kind == StepKind.AGENT
    assert use_cases.agent_id == "harness_usecases"
    assert use_cases.needs == ("harvest-ubiquitous-language",)
    assert use_cases.inputs == (Path("context.md"), Path("docs/design/요구사항.md"))
    assert use_cases.outputs == (Path("docs/design/유스케이스.md"), Path("docs/use-cases"))
    assert use_cases.metadata["scope"] == "canonical_use_cases"

    assert capture.kind == StepKind.RECORD
    assert capture.needs == ("harvest-use-cases",)
    assert capture.metadata["scope"] == "change_set"

    assert change_set.kind == StepKind.RECORD
    assert change_set.needs == ("capture-implementation-intent",)
    assert Path("docs/changes/active/<CHG-ID>.md") in change_set.outputs

    assert affected.kind == StepKind.DECISION
    assert affected.needs == ("create-change-set",)
    assert affected.metadata["scope"] == "affected_use_cases"


def test_harness_full_workflow_orchestrates_use_case_scoped_loop() -> (
    None
):
    storming = HARNESS_FULL_WORKFLOW.step_by_id("storm-affected-use-case")
    design = HARNESS_FULL_WORKFLOW.step_by_id("design-affected-use-case")
    planner = HARNESS_FULL_WORKFLOW.step_by_id("planner-create-use-case-plan")
    executor = HARNESS_FULL_WORKFLOW.step_by_id("executor-implement-use-case-plan")
    verification = HARNESS_FULL_WORKFLOW.step_by_id("verifier-run-use-case-e2e")

    assert storming.kind == StepKind.AGENT
    assert storming.agent_id == "oracle"
    assert storming.needs == ("identify-affected-use-cases",)
    assert Path("docs/use-cases/<UC-ID>/event-storming.md") in storming.outputs

    assert design.kind == StepKind.AGENT
    assert design.agent_id == "ddd_architect"
    assert design.needs == ("storm-affected-use-case",)
    assert Path("docs/use-cases/<UC-ID>/ddd-design.md") in design.outputs

    assert planner.kind == StepKind.AGENT
    assert planner.agent_id == "implementation_planner"
    assert planner.needs == ("design-affected-use-case",)
    assert Path("docs/plans/active/<UC-ID>/plan.md") in planner.outputs

    assert executor.kind == StepKind.AGENT
    assert executor.agent_id == "implementation_executor"
    assert executor.needs == ("planner-create-use-case-plan",)
    assert Path("docs/plans/active/<UC-ID>/plan.md") in executor.inputs

    assert verification.kind == StepKind.VALIDATOR
    assert verification.needs == ("executor-implement-use-case-plan",)
    assert Path("docs/use-cases/<UC-ID>/e2e-goal.md") in verification.inputs
    assert "./gradlew build" in verification.metadata["typical_commands"]
    assert "./gradlew test" in verification.metadata["typical_commands"]


def test_harness_full_workflow_records_use_case_repeat_loop_intent() -> None:
    decision = HARNESS_FULL_WORKFLOW.step_by_id(
        "classify-use-case-verification-result"
    )
    remediation = HARNESS_FULL_WORKFLOW.step_by_id("revise-use-case-plan-and-repeat")

    assert decision.kind == StepKind.DECISION
    assert decision.needs == ("verifier-run-use-case-e2e",)
    assert (
        decision.metadata["on_implementation_failure"]
        == "revise-use-case-plan-and-repeat"
    )
    assert decision.metadata["on_success"] == "complete-use-case-plan"

    assert remediation.kind == StepKind.RECORD
    assert remediation.needs == ("classify-use-case-verification-result",)
    assert remediation.metadata["loop_target"] == "executor-implement-use-case-plan"
    assert remediation.metadata["loop_until"] == "use_case_e2e_passes_or_blocker"
    assert Path("docs/plans/active/<UC-ID>/plan.md") in remediation.outputs


def test_harness_full_workflow_records_use_case_blocker_path() -> None:
    blocker = HARNESS_FULL_WORKFLOW.step_by_id("record-use-case-blocker")

    assert blocker.kind == StepKind.RECORD
    assert blocker.needs == ("classify-use-case-verification-result",)
    assert "upstream_design_blocker" in blocker.metadata["stop_reasons"]
    assert "environment_blocker" in blocker.metadata["stop_reasons"]
    assert Path("docs/plans/active/<UC-ID>/plan.md") in blocker.outputs


def test_harness_full_workflow_records_use_case_and_change_set_completion() -> None:
    complete_uc = HARNESS_FULL_WORKFLOW.step_by_id("complete-use-case-plan")
    complete_change_set = HARNESS_FULL_WORKFLOW.step_by_id("complete-change-set")

    assert complete_uc.kind == StepKind.GIT
    assert complete_uc.needs == ("classify-use-case-verification-result",)
    assert (
        complete_uc.metadata["condition"]
        == "use_case_e2e_goal_and_quality_gates_passed"
    )
    assert Path("docs/plans/active/<UC-ID>/plan.md") in complete_uc.inputs
    assert Path("docs/plans/completed/<UC-ID>/plan.md") in complete_uc.outputs

    assert complete_change_set.kind == StepKind.GIT
    assert complete_change_set.needs == ("complete-use-case-plan",)
    assert (
        complete_change_set.metadata["condition"]
        == "all_affected_use_case_plans_completed"
    )
    assert Path("docs/changes/active/<CHG-ID>.md") in complete_change_set.inputs
    assert Path("docs/changes/completed/<CHG-ID>.md") in complete_change_set.outputs
