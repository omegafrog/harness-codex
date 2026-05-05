from pathlib import Path

from harness_codex.runtime import (
    ResumeDisposition,
    RunFailureKind,
    RunMode,
    RunState,
    RunStateStore,
    RunStatus,
    UseCaseLoopState,
    UseCaseStep,
    decide_resume_target,
)


def test_run_state_store_round_trips_json(tmp_path: Path) -> None:
    state = RunState(
        run_id="run-001",
        change_set_id="CHG-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-001", "UC-002"),
        current_use_case_id="UC-001",
        current_step_id=UseCaseStep.VERIFY,
        status=RunStatus.RUNNING,
        use_case_states=(
            UseCaseLoopState(
                uc_id="UC-001",
                active_plan_path=Path("docs/plans/active/UC-001/plan.md"),
                status=RunStatus.RUNNING,
                current_step_id=UseCaseStep.VERIFY,
            ),
        ),
    )
    store = RunStateStore(tmp_path)

    path = store.save(state)
    loaded = store.load("run-001")

    assert path == tmp_path / ".harness/runs/run-001/state.json"
    assert loaded == state


def test_resume_skips_completed_use_cases() -> None:
    state = RunState(
        run_id="run-001",
        change_set_id="CHG-001",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-001", "UC-002"),
        completed_use_cases=("UC-001",),
        status=RunStatus.RUNNING,
    )

    target = decide_resume_target(state)

    assert target.disposition == ResumeDisposition.NEXT_USE_CASE
    assert target.uc_id == "UC-002"
    assert target.step_id == UseCaseStep.PLAN


def test_implementation_failure_resumes_from_remediation_loop() -> None:
    state = RunState(
        run_id="run-001",
        change_set_id="CHG-001",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-001",),
        current_use_case_id="UC-001",
        failed_step_id="verifier-run-use-case-e2e",
        failure_kind=RunFailureKind.IMPLEMENTATION_FAILURE,
        status=RunStatus.FAILED,
    )

    target = decide_resume_target(state)

    assert target.disposition == ResumeDisposition.RETRY_REMEDIATION
    assert target.uc_id == "UC-001"
    assert target.step_id == UseCaseStep.REMEDIATE


def test_non_implementation_failures_wait_for_upstream_resolution() -> None:
    cases = {
        RunFailureKind.UNCLEAR_E2E_GOAL: ResumeDisposition.WAIT_FOR_GOAL_CLARIFICATION,
        RunFailureKind.DOCUMENT_DELTA_CONFLICT: ResumeDisposition.WAIT_FOR_CHANGESET_REVISION,
        RunFailureKind.UPSTREAM_DESIGN_CONFLICT: ResumeDisposition.WAIT_FOR_UPSTREAM_DESIGN,
        RunFailureKind.ENVIRONMENT_BLOCKER: ResumeDisposition.WAIT_FOR_ENVIRONMENT,
    }

    for failure_kind, expected in cases.items():
        state = RunState(
            run_id="run-001",
            change_set_id="CHG-001",
            workflow_name="workflow",
            mode=RunMode.APPLY,
            affected_use_cases=("UC-001",),
            current_use_case_id="UC-001",
            failure_kind=failure_kind,
            status=RunStatus.BLOCKED,
        )

        assert decide_resume_target(state).disposition == expected


def test_completed_run_has_no_resume_target() -> None:
    state = RunState(
        run_id="run-001",
        change_set_id="CHG-001",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-001",),
        completed_use_cases=("UC-001",),
        status=RunStatus.SUCCEEDED,
    )

    target = decide_resume_target(state)

    assert target.disposition == ResumeDisposition.COMPLETE
    assert target.uc_id is None
