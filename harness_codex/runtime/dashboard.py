"""Dashboard data model backed by saved runtime state projections."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.models import RunStatus
from harness_codex.runtime.state_projection import load_dashboard_projections


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


@dataclass(frozen=True)
class DashboardRun:
    """Dashboard projection for one run."""

    run_id: str
    change_set_id: str
    status: RunStatus
    work_items: tuple[DashboardWorkItem, ...]
    report_path: Path


def load_dashboard_runs(repo_root: Path | str) -> tuple[DashboardRun, ...]:
    """Read the persisted dashboard index without walking run artifacts."""

    runs: list[DashboardRun] = []
    for payload in load_dashboard_projections(repo_root):
        run = _dashboard_run_from_projection(payload)
        if run is not None:
            runs.append(run)
    return tuple(runs)


def dashboard_state_json(repo_root: Path | str) -> str:
    """Return the saved canonical dashboard state as deterministic JSON."""

    return json.dumps(
        list(load_dashboard_projections(repo_root)),
        ensure_ascii=False,
        indent=2,
    ) + "\n"


def _dashboard_run_from_projection(payload: dict) -> DashboardRun | None:
    try:
        work_items = tuple(
            DashboardWorkItem(
                work_item_id=str(item["id"]),
                work_item_type=WorkItemType(str(item["type"])),
                plan_path=Path(str(item["plan_path"])),
                current_stage=str(item["current_stage"]),
                status=RunStatus(str(item["status"])),
                blocker=str(item.get("blocker") or ""),
                verification_result=str(item.get("verification_result") or ""),
                failure_class=str(item.get("failure_class") or ""),
            )
            for item in payload.get("work_items", [])
            if isinstance(item, dict)
        )
        return DashboardRun(
            run_id=str(payload["run_id"]),
            change_set_id=str(payload["change_set_id"]),
            status=RunStatus(str(payload["status"])),
            work_items=work_items,
            report_path=Path(str(payload["report_path"])),
        )
    except (KeyError, TypeError, ValueError):
        return None
