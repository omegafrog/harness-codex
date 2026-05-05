from pathlib import Path

from harness_codex.runtime import (
    HARNESS_FULL_WORKFLOW,
    CommandCheck,
    RequiredStageCheck,
    UseCaseVerificationInput,
    UseCaseVerificationResult,
    VerificationStatus,
)


def test_use_case_verification_input_targets_one_plan_and_e2e_goal() -> None:
    verification_input = UseCaseVerificationInput(
        change_set_path=Path("docs/changes/active/CHG-1.md"),
        plan_path=Path("docs/plans/active/UC-1/plan.md"),
        e2e_goal_path=Path("docs/use-cases/UC-1/e2e-goal.md"),
    )

    assert verification_input.plan_path == Path("docs/plans/active/UC-1/plan.md")
    assert verification_input.e2e_goal_path == Path(
        "docs/use-cases/UC-1/e2e-goal.md"
    )
    assert verification_input.repository_settings_path == Path(
        ".codex/repository-settings.md"
    )
    assert verification_input.test_gate_path == Path(".codex/test-gate.yaml")
    assert "./gradlew test" in verification_input.required_commands
    assert "./gradlew e2eTest" in verification_input.required_commands


def test_verification_result_distinguishes_retryable_failure() -> None:
    implementation_failure = UseCaseVerificationResult(
        status=VerificationStatus.IMPLEMENTATION_FAILURE,
        command_checks=(
            CommandCheck(
                name="Tests",
                command="./gradlew test",
                passed=False,
                evidence="failing application service test",
            ),
        ),
    )
    unclear_goal = UseCaseVerificationResult(
        status=VerificationStatus.UNCLEAR_E2E_GOAL,
        blocker="E2E goal has no observable success criteria",
    )

    assert implementation_failure.passed is False
    assert implementation_failure.resumable_by_executor is True
    assert unclear_goal.resumable_by_executor is False


def test_verification_status_covers_orchestrator_failure_classification() -> None:
    assert {status.value for status in VerificationStatus} == {
        "PASS",
        "IMPLEMENTATION_FAILURE",
        "UNCLEAR_E2E_GOAL",
        "DOCUMENT_DELTA_CONFLICT",
        "UPSTREAM_DESIGN_CONFLICT",
        "ENVIRONMENT_BLOCKER",
    }


def test_workflow_verifier_step_records_e2e_and_test_gate() -> None:
    verification = HARNESS_FULL_WORKFLOW.step_by_id("verifier-run-use-case-e2e")

    assert Path("docs/plans/active/<UC-ID>/plan.md") in verification.inputs
    assert Path("docs/use-cases/<UC-ID>/e2e-goal.md") in verification.inputs
    assert Path(".codex/test-gate.yaml") in verification.inputs
    assert "./gradlew test" in verification.metadata["typical_commands"]
    assert "./gradlew e2eTest" in verification.metadata["typical_commands"]
    assert ".codex/test-gate.yaml" in verification.metadata["test_gate"]


def test_test_gate_check_records_required_stage_result() -> None:
    result = UseCaseVerificationResult(
        status=VerificationStatus.PASS,
        test_gate_checks=(
            RequiredStageCheck(stage="unit", passed=True, evidence="./gradlew test"),
            RequiredStageCheck(stage="e2e", passed=True, evidence="./gradlew e2eTest"),
        ),
    )

    assert result.passed is True
    assert all(check.passed for check in result.test_gate_checks)
