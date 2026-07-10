from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.dashboard import dashboard_state_json, load_dashboard_runs
from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.procedure_stages import render_initial_changeset
from harness_codex.runtime.state import RunState, UseCaseLoopState, WorkItemLoopState
from harness_codex.runtime.state_projection import (
    STATE_SCHEMA_VERSION,
    persist_canonical_run_state,
)
from harness_codex.runtime.state import RunStateStore


def test_persist_canonical_run_state_converts_legacy_use_case_rows(tmp_path: Path) -> None:
    legacy = RunState(
        run_id="run-legacy",
        change_set_id="CHG-1",
        workflow_name="changeset-session",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-1",),
        completed_use_cases=("UC-1",),
        status=RunStatus.SUCCEEDED,
        use_case_states=(
            UseCaseLoopState(
                uc_id="UC-1",
                active_plan_path=Path("docs/plans/active/UC-1/plan.md"),
                status=RunStatus.SUCCEEDED,
                verification_status="PASS",
            ),
        ),
    )

    canonical = persist_canonical_run_state(tmp_path, legacy)

    assert canonical.use_case_states == ()
    assert canonical.completed_use_cases == ()
    assert canonical.affected_work_items == ("UC-1",)
    assert canonical.completed_work_items == ("UC-1",)
    assert canonical.work_item_states[0].work_item_type is WorkItemType.USE_CASE
    assert canonical.decision_results["runtime_state_schema_version"] == STATE_SCHEMA_VERSION


def test_run_state_store_uses_xml_only(tmp_path: Path) -> None:
    state = RunState(
        run_id="run-xml-only",
        change_set_id="CHG-XML-ONLY",
        workflow_name="changeset-session",
        mode=RunMode.APPLY,
        status=RunStatus.RUNNING,
    )

    path = RunStateStore(tmp_path).save(state)

    assert path == tmp_path / ".harness/state/changesets/CHG-XML-ONLY/state.xml"
    assert path.is_file()
    assert not (tmp_path / ".harness/runs").exists()
    assert RunStateStore(tmp_path).load(state.run_id).change_set_id == state.change_set_id


def test_dashboard_reads_saved_index_without_state_glob(tmp_path: Path) -> None:
    state = RunState(
        run_id="run-indexed",
        change_set_id="CHG-2",
        workflow_name="changeset-session",
        mode=RunMode.APPLY,
        affected_work_items=("MAINT-1",),
        status=RunStatus.SUCCEEDED,
    )
    persist_canonical_run_state(tmp_path, state)

    runs = load_dashboard_runs(tmp_path)

    assert "run-indexed" in [run.run_id for run in runs]
    assert '"run_id": "run-indexed"' in dashboard_state_json(tmp_path)


def test_dashboard_projection_uses_verdict_classification_without_routing(tmp_path: Path) -> None:
    state = RunState(
        run_id="run-verdict",
        change_set_id="CHG-3",
        workflow_name="changeset-session",
        mode=RunMode.APPLY,
        affected_work_items=("UC-3",),
        status=RunStatus.BLOCKED,
        work_item_states=(
            WorkItemLoopState(
                work_item_id="UC-3",
                work_item_type=WorkItemType.USE_CASE,
                active_plan_path=Path("docs/plans/active/UC-3/plan.md"),
                status=RunStatus.BLOCKED,
                verification_status="blocked",
            ),
        ),
        decision_results={
            "UC-3": (
                {"decision": "ignored"},
                {
                    "verification": {
                        "failure_class": "security_review_failure",
                        "owner_stage": "implementation-planner",
                        "recommended_resume_target": "prepare-plan-repair",
                    }
                },
            )
        },
    )
    persist_canonical_run_state(tmp_path, state)

    item = load_dashboard_runs(tmp_path)[0].work_items[0]
    payload = dashboard_state_json(tmp_path)

    assert item.failure_class == "security_review_failure"
    assert not hasattr(item, "owner_stage")
    assert not hasattr(item, "recommended_resume_target")
    assert "owner_stage" not in payload
    assert "recommended_resume_target" not in payload


def test_canonical_dashboard_projection_includes_contract_gate_summary(tmp_path: Path) -> None:
    change_set_id = "CHG-GATE-1"
    change_path = tmp_path / "docs/changes/active" / f"{change_set_id}.md"
    change_path.parent.mkdir(parents=True)
    change_path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title="계약 게이트",
            request_summary="계약 dashboard 상태를 legacy projection에 반영",
        ),
        encoding="utf-8",
    )
    state = RunState(
        run_id=f"changeset-state-{change_set_id}",
        change_set_id=change_set_id,
        workflow_name="changeset-runtime-state",
        mode=RunMode.APPLY,
        status=RunStatus.PENDING,
    )

    persist_canonical_run_state(tmp_path, state)

    payload = dashboard_state_json(tmp_path)
    assert '"run_status": "pending"' in payload
    assert '"status": "succeeded"' in payload
    assert '"current_gate": "complete"' in payload
    assert '"blocker_count": 0' in payload
