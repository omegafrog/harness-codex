"""Canonical work-item state and saved dashboard projections.

Legacy runs may contain both ``use_case_states`` and ``work_item_states``.
This module treats work-item records as the only execution-state representation,
converts legacy use-case rows during migration, and writes a compact dashboard
index at mutation time. Dashboard reads never need to scan run artifacts.

The projection carries verifier verdict data only. Owner-stage and resume-target
routing decisions are intentionally absent because they belong to the
orchestration workflow brain, not persisted verifier state.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import replace
from pathlib import Path
from typing import Any

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.state import (
    RunState,
    RunStateStore,
    UseCaseLoopState,
    WorkItemLoopState,
)

STATE_SCHEMA_VERSION = 2
DASHBOARD_INDEX_RELATIVE_PATH = Path(".harness/dashboard/index.json")
DASHBOARD_SNAPSHOT_RELATIVE_DIR = Path(".harness/dashboard/runs")


def canonical_work_item_states(state: RunState) -> tuple[WorkItemLoopState, ...]:
    """Return one stable record per work item, favoring native work-item rows."""

    by_id: dict[str, WorkItemLoopState] = {
        item.work_item_id: item for item in state.work_item_states
    }
    for item in state.use_case_states:
        by_id.setdefault(item.uc_id, _from_legacy_use_case(item))
    return tuple(
        by_id[item_id]
        for item_id in _ordered_item_ids(state, by_id)
        if item_id in by_id
    )


def canonicalize_run_state(state: RunState) -> RunState:
    """Normalize one run into schema v2 while retaining loader compatibility."""

    work_items = canonical_work_item_states(state)
    item_ids = tuple(item.work_item_id for item in work_items)
    affected = _merge_ordered(
        state.affected_work_items or (),
        item_ids,
        state.affected_use_cases,
    )
    completed = _merge_ordered(
        state.completed_work_items,
        state.completed_use_cases,
    )
    blocked = _merge_ordered(
        state.blocked_work_items,
        state.blocked_use_cases,
    )
    decisions = dict(state.decision_results)
    decisions["runtime_state_schema_version"] = STATE_SCHEMA_VERSION
    return replace(
        state,
        affected_work_items=affected,
        completed_work_items=completed,
        blocked_work_items=blocked,
        completed_use_cases=(),
        blocked_use_cases=(),
        use_case_states=(),
        work_item_states=work_items,
        decision_results=decisions,
    )


def persist_canonical_run_state(repo_root: Path | str, state: RunState) -> RunState:
    """Save normalized state and refresh its dashboard projection."""

    root = Path(repo_root)
    canonical = canonicalize_run_state(state)
    RunStateStore(root).save(canonical)
    write_dashboard_projection(root, canonical)
    return canonical


def migrate_legacy_runtime_state(repo_root: Path | str) -> tuple[str, ...]:
    """Migrate existing run state and build dashboard projections at startup.

    The function is deliberately invoked at an executable startup or explicit
    maintenance boundary, never by dashboard rendering.
    """

    root = Path(repo_root)
    runs_root = root / ".harness/runs"
    if not runs_root.exists():
        return ()
    store = RunStateStore(root)
    migrated: list[str] = []
    for path in sorted(runs_root.glob("*/state.json")):
        try:
            state = store.load(path.parent.name)
        except (FileNotFoundError, KeyError, TypeError, ValueError):
            continue
        canonical = canonicalize_run_state(state)
        if _needs_state_rewrite(state, canonical):
            store.save(canonical)
            migrated.append(canonical.run_id)
        write_dashboard_projection(root, canonical)
    return tuple(migrated)


def write_dashboard_projection(repo_root: Path | str, state: RunState) -> Path:
    """Write a single-run snapshot and update the compact dashboard index."""

    root = Path(repo_root)
    projection = dashboard_projection(state, repo_root=root)
    snapshot_path = root / DASHBOARD_SNAPSHOT_RELATIVE_DIR / f"{state.run_id}.json"
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    snapshot_path.write_text(
        json.dumps(projection, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    index_path = root / DASHBOARD_INDEX_RELATIVE_PATH
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index = _load_dashboard_index(index_path)
    runs = {
        str(item.get("run_id")): item
        for item in index.get("runs", [])
        if isinstance(item, dict) and item.get("run_id")
    }
    runs[state.run_id] = projection
    payload = {
        "schema_version": STATE_SCHEMA_VERSION,
        "runs": [runs[key] for key in sorted(runs)],
    }
    index_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return snapshot_path


def dashboard_projection(
    state: RunState,
    *,
    repo_root: Path | str | None = None,
) -> dict[str, Any]:
    """Return the stable JSON row consumed by the dashboard service."""

    contract_summary = _contract_gate_summary(repo_root, state.change_set_id) if repo_root else {}
    status = state.status.value
    if _is_canonical_change_set_run(state) and contract_summary:
        if contract_summary.get("blocker_count", 0):
            status = "blocked"
        elif contract_summary.get("current_gate") == "complete":
            status = "succeeded"
    work_items = []
    for item in canonical_work_item_states(state):
        failure_class = _failure_class_for(state, item.work_item_id)
        row = {
            "id": item.work_item_id,
            "type": item.work_item_type.value,
            "plan_path": str(item.active_plan_path),
            "current_stage": str(item.current_step_id),
            "status": item.status.value,
            "blocker": item.blocker or "",
            "verification_result": item.verification_status,
        }
        if failure_class:
            row["failure_class"] = failure_class
        work_items.append(row)
    return {
        "run_id": state.run_id,
        "change_set_id": state.change_set_id,
        "status": status,
        "run_status": state.status.value,
        "report_path": str(Path(".harness/runs") / state.run_id / "report.md"),
        **contract_summary,
        "work_items": work_items,
    }


def load_dashboard_projections(repo_root: Path | str) -> tuple[dict[str, Any], ...]:
    """Read the saved dashboard index without scanning run directories."""

    index = _load_dashboard_index(Path(repo_root) / DASHBOARD_INDEX_RELATIVE_PATH)
    rows = index.get("runs", [])
    if not isinstance(rows, list):
        return ()
    return tuple(item for item in rows if isinstance(item, dict))


def _from_legacy_use_case(item: UseCaseLoopState) -> WorkItemLoopState:
    return WorkItemLoopState(
        work_item_id=item.uc_id,
        work_item_type=WorkItemType.USE_CASE,
        active_plan_path=item.active_plan_path,
        status=item.status,
        current_step_id=item.current_step_id.value,
        verification_status=item.verification_status,
        retry_count=item.retry_count,
        last_executor_result=item.last_executor_result,
        last_verifier_result=item.last_verifier_result,
        failure_kind=item.failure_kind,
        blocker=item.blocker,
    )


def _ordered_item_ids(
    state: RunState,
    records: dict[str, WorkItemLoopState],
) -> tuple[str, ...]:
    return _merge_ordered(
        state.affected_work_items,
        tuple(records),
        state.affected_use_cases,
    )


def _merge_ordered(*groups: Iterable[str]) -> tuple[str, ...]:
    seen: set[str] = set()
    ordered: list[str] = []
    for group in groups:
        for value in group:
            if value and value not in seen:
                seen.add(value)
                ordered.append(value)
    return tuple(ordered)


def _needs_state_rewrite(before: RunState, after: RunState) -> bool:
    return (
        before.use_case_states != after.use_case_states
        or before.work_item_states != after.work_item_states
        or before.affected_work_items != after.affected_work_items
        or before.completed_work_items != after.completed_work_items
        or before.blocked_work_items != after.blocked_work_items
        or before.completed_use_cases
        or before.blocked_use_cases
        or before.decision_results.get("runtime_state_schema_version") != STATE_SCHEMA_VERSION
    )


def _is_canonical_change_set_run(state: RunState) -> bool:
    return state.run_id.startswith("changeset-state-")


def _contract_gate_summary(
    repo_root: Path | str | None,
    change_set_id: str,
) -> dict[str, Any]:
    if repo_root is None:
        return {}
    try:
        from harness_codex.runtime.contracts.dashboard_projection import (
            contract_dashboard_projection,
        )

        projection = contract_dashboard_projection(repo_root, change_set_id=change_set_id)
    except (OSError, KeyError, TypeError, ValueError):
        return {}
    change_sets = projection.get("change_sets")
    if not isinstance(change_sets, list) or not change_sets:
        return {}
    current = change_sets[0]
    if not isinstance(current, dict):
        return {}
    return {
        "change_set_status": str(current.get("status") or ""),
        "current_gate": str(current.get("current_gate") or ""),
        "blocker_count": int(current.get("blocker_count") or 0),
        "projection_source": "run_state_with_contract_gate",
    }


def _failure_class_for(state: RunState, work_item_id: str) -> str:
    """Read verifier verdict classification from recorded decision history."""

    raw = state.decision_results.get(work_item_id)
    if isinstance(raw, Mapping):
        return _failure_class_field(raw)
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes, bytearray)):
        return ""
    for decision in reversed(raw):
        if not isinstance(decision, Mapping):
            continue
        failure_class = _failure_class_field(decision)
        if failure_class:
            return failure_class
        nested = decision.get("verification")
        if isinstance(nested, Mapping):
            failure_class = _failure_class_field(nested)
            if failure_class:
                return failure_class
    return ""


def _failure_class_field(payload: Mapping[str, Any]) -> str:
    value = payload.get("failure_class")
    return value if isinstance(value, str) else ""


def _load_dashboard_index(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {"schema_version": STATE_SCHEMA_VERSION, "runs": []}
    if not isinstance(payload, dict):
        return {"schema_version": STATE_SCHEMA_VERSION, "runs": []}
    return payload
