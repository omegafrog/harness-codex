from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.dashboard import dashboard_state_json, load_dashboard_runs
from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.state import RunState, UseCaseLoopState
from harness_codex.runtime.state_projection import (
    STATE_SCHEMA_VERSION,
    persist_canonical_run_state,
)


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

    # A malformed legacy state must not affect dashboard reads after the index
    # was written; the dashboard consumes only the saved projection.
    legacy = tmp_path / ".harness/runs/run-broken/state.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text("not-json", encoding="utf-8")

    runs = load_dashboard_runs(tmp_path)

    assert [run.run_id for run in runs] == ["run-indexed"]
    assert '"run_id": "run-indexed"' in dashboard_state_json(tmp_path)
