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
    failure_class: str = ""
    owner_stage: str = ""
    recommended_resume_target: str = ""


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
            _dashboard_work_item(
                root,
                state.run_id,
                item.work_item_id,
                item.work_item_type,
                item.active_plan_path,
                item.current_step_id,
                item.status,
                item.blocker or "",
                item.verification_status,
            )
            for item in state.work_item_states
        ]
        if not work_items:
            work_items = [
                _dashboard_work_item(
                    root,
                    state.run_id,
                    item.uc_id,
                    WorkItemType.USE_CASE,
                    item.active_plan_path,
                    item.current_step_id.value,
                    item.status,
                    item.blocker or "",
                    item.verification_status,
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


def _dashboard_work_item(
    repo_root: Path,
    run_id: str,
    work_item_id: str,
    work_item_type: WorkItemType,
    plan_path: Path,
    current_stage: object,
    status: RunStatus,
    blocker: str,
    verification_result: str,
) -> DashboardWorkItem:
    routing = _verification_routing(repo_root, run_id, work_item_id)
    return DashboardWorkItem(
        work_item_id=work_item_id,
        work_item_type=work_item_type,
        plan_path=plan_path,
        current_stage=str(current_stage),
        status=status,
        blocker=blocker,
        verification_result=verification_result,
        failure_class=routing.get("failure_class", ""),
        owner_stage=routing.get("owner_stage", ""),
        recommended_resume_target=routing.get("recommended_resume_target", ""),
    )


def _verification_routing(repo_root: Path, run_id: str, work_item_id: str) -> dict[str, str]:
    report_path = (
        repo_root
        / ".harness/runs"
        / run_id
        / "work-items"
        / work_item_id
        / "verification/report.json"
    )
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    return {
        key: value
        for key in ("failure_class", "owner_stage", "recommended_resume_target")
        if isinstance((value := payload.get(key)), str)
    }


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
                    "failure_class": item.failure_class,
                    "owner_stage": item.owner_stage,
                    "recommended_resume_target": item.recommended_resume_target,
                }
                for item in run.work_items
            ],
        }
        for run in load_dashboard_runs(repo_root)
    ]
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"
