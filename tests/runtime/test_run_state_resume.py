from pathlib import Path

from harness_codex.runtime import (
    ArtifactDirtyState,
    ResumeDisposition,
    RunFailureKind,
    RunMode,
    RunState,
    RunStateStore,
    RunStatus,
    StageArtifactState,
    UseCaseLoopState,
    UseCaseStep,
    WorkItemLoopState,
    decide_resume_target,
    reconcile_procedure_stage_rows,
)
from harness_codex.runtime.changes.models import WorkItemType


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
        decision_results={
            "UC-001": [
                {
                    "step_id": "classify-verification-result",
                    "decision": "IMPLEMENTATION_FAILURE",
                    "route": "remediate-work-item",
                },
            ]
        },
        use_case_states=(
            UseCaseLoopState(
                uc_id="UC-001",
                active_plan_path=Path("docs/plans/active/UC-001/plan.md"),
                status=RunStatus.RUNNING,
                current_step_id=UseCaseStep.VERIFY,
                retry_count=1,
                failure_kind=RunFailureKind.IMPLEMENTATION_FAILURE,
            ),
        ),
        work_item_states=(
            WorkItemLoopState(
                work_item_id="UC-001",
                work_item_type=WorkItemType.USE_CASE,
                active_plan_path=Path("docs/plans/active/UC-001/plan.md"),
                status=RunStatus.RUNNING,
                current_step_id="verify",
                retry_count=1,
                failure_kind=RunFailureKind.IMPLEMENTATION_FAILURE,
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


def test_resume_targets_next_maintenance_work_item() -> None:
    state = RunState(
        run_id="run-001",
        change_set_id="CHG-001",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-001",),
        affected_work_items=("UC-001", "MAINT-001"),
        completed_use_cases=("UC-001",),
        completed_work_items=("UC-001",),
        work_item_states=(
            WorkItemLoopState(
                work_item_id="MAINT-001",
                work_item_type=WorkItemType.MAINTENANCE,
                active_plan_path=Path("docs/plans/active/MAINT-001/plan.md"),
            ),
        ),
        status=RunStatus.RUNNING,
    )

    target = decide_resume_target(state)

    assert target.work_item_id == "MAINT-001"
    assert target.work_item_type == WorkItemType.MAINTENANCE
    assert target.step_id == UseCaseStep.PLAN


def test_artifact_acceptance_records_revision_and_downstream_reapply(
    tmp_path: Path,
) -> None:
    stage_path = Path("docs/design/use_cases.md")
    (tmp_path / stage_path).parent.mkdir(parents=True)
    (tmp_path / stage_path).write_text("v1", encoding="utf-8")
    store = RunStateStore(tmp_path)
    store.save(
        RunState(
            run_id="run-001",
            change_set_id="CHG-001",
            workflow_name="workflow",
            mode=RunMode.APPLY,
            affected_use_cases=(),
            affected_work_items=("MAINT-001",),
        )
    )

    state = store.save_artifact_acceptance("run-001", "use_cases", stage_path)

    artifact = state.artifact_states[0]
    assert artifact.revision == 1
    assert artifact.accepted is True
    assert artifact.downstream_status == ArtifactDirtyState.NEEDS_REAPPLY


def test_reconcile_procedure_stage_rows_detects_changeset_table_drift() -> None:
    state = RunState(
        run_id="run-001",
        change_set_id="CHG-001",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-001",),
        artifact_states=(
            StageArtifactState(
                stage="technical-decisions",
                path=Path("docs/use-cases/UC-001/technical-decisions.md"),
                accepted=False,
                downstream_status=ArtifactDirtyState.NEEDS_REAPPLY,
            ),
        ),
    )

    drifts = reconcile_procedure_stage_rows(
        state,
        (
            {
                "id": "technical-decisions",
                "status": "approved",
                "notes": "approved by user",
            },
        ),
    )

    assert len(drifts) == 1
    assert drifts[0].stage == "technical-decisions"
    assert drifts[0].runtime_status == "pending"
    assert drifts[0].table_status == "verified"
