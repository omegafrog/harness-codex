"""Dashboard data model for local harness run state."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.models import RunStatus
from harness_codex.runtime.state import RunStateStore


@dataclass(frozen=True)
class DashboardWorkItem:
    """One rendered row in the run dashboard."""

    work_item_id: str
    work_item_type: WorkItemType
    plan_path: Path
    current_stage: str
    status: RunStatus
    blocker: str = ""
    verification_result: str = ""


@dataclass(frozen=True)
class DashboardRun:
    """Dashboard projection for one run."""

    run_id: str
    change_set_id: str
    status: RunStatus
    work_items: tuple[DashboardWorkItem, ...]
    report_path: Path


def load_dashboard_runs(repo_root: Path | str) -> tuple[DashboardRun, ...]:
    """Load `.harness/runs/**/state.json` into UI-friendly rows."""

    root = Path(repo_root)
    runs_dir = root / ".harness/runs"
    if not runs_dir.exists():
        return ()

    store = RunStateStore(root)
    runs: list[DashboardRun] = []

    for state_path in sorted(runs_dir.glob("*/state.json")):
        state = store.load(state_path.parent.name)
        work_items = [
            DashboardWorkItem(
                work_item_id=item.work_item_id,
                work_item_type=item.work_item_type,
                plan_path=item.active_plan_path,
                current_stage=item.current_step_id,
                status=item.status,
                blocker=item.blocker or "",
                verification_result=item.verification_status,
            )
            for item in state.work_item_states
        ]
        if not work_items:
            work_items = [
                DashboardWorkItem(
                    work_item_id=item.uc_id,
                    work_item_type=WorkItemType.USE_CASE,
                    plan_path=item.active_plan_path,
                    current_stage=item.current_step_id.value,
                    status=item.status,
                    blocker=item.blocker or "",
                    verification_result=item.verification_status,
                )
                for item in state.use_case_states
            ]
        runs.append(
            DashboardRun(
                run_id=state.run_id,
                change_set_id=state.change_set_id,
                status=state.status,
                work_items=tuple(work_items),
                report_path=Path(".harness/runs") / state.run_id / "report.md",
            )
        )

    return tuple(runs)


def dashboard_state_json(repo_root: Path | str) -> str:
    """Return dashboard state as deterministic JSON for smoke tests/UI shells."""

    data = [
        {
            "run_id": run.run_id,
            "change_set_id": run.change_set_id,
            "status": run.status.value,
            "report_path": str(run.report_path),
            "work_items": [
                {
                    "id": item.work_item_id,
                    "type": item.work_item_type.value,
                    "plan_path": str(item.plan_path),
                    "current_stage": item.current_stage,
                    "status": item.status.value,
                    "blocker": item.blocker,
                    "verification_result": item.verification_result,
                }
                for item in run.work_items
            ],
        }
        for run in load_dashboard_runs(repo_root)
    ]
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"
