"""Keep dashboard progress and document invalidation inside canonical RunState.

The dashboard retains scoped UI session data for interactive questions and in-flight
DDD substeps. That data may explain progress, but it must never become an
independent gate source. This patch persists a normalized per-substep projection
in the canonical ChangeSet RunState and routes document-edit invalidations through
the same procedure-stage recorder used by CLI commands.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any


_PATCHED_ATTR = "_harness_dashboard_gate_state_patch_applied"
_DDD_SUBSTEP_RESULTS_KEY = "dashboard_ddd_substep_results"


def apply_dashboard_gate_state_patch() -> None:
    """Install canonical dashboard progress and invalidation bridges."""

    try:
        from harness_codex import cli
        from harness_codex.runtime import (
            dashboard_runtime_state as dashboard,
            document_dashboard,
            ui_server,
        )
    except ImportError:
        return

    if getattr(dashboard, _PATCHED_ATTR, False):
        return

    original_sync = dashboard.sync_change_set_runtime_state

    def sync_with_ddd_substep_projection(
        repo_root: Path | str,
        change_set_id: str,
        session: dict[str, Any],
    ):
        state = original_sync(repo_root, change_set_id, session)
        substeps = _canonical_ddd_substep_results(session)
        if substeps is None:
            return state

        decisions = dict(state.decision_results)
        if decisions.get(_DDD_SUBSTEP_RESULTS_KEY) == substeps:
            return state

        updated = replace(
            state,
            decision_results={**decisions, _DDD_SUBSTEP_RESULTS_KEY: substeps},
        )
        root = Path(repo_root)
        dashboard.RunStateStore(root).save(updated)
        dashboard.reconcile_change_set_procedure_table(root, updated)
        return updated

    dashboard.sync_change_set_runtime_state = sync_with_ddd_substep_projection

    # document_dashboard imported the projection before procedure-stage canonical
    # hooks were installed. Point its runtime lookup at the canonical projection
    # so dashboard rendering and gate decisions expose the same status values.
    document_dashboard.runtime_stage_projection = dashboard.runtime_stage_projection

    original_save_document = document_dashboard.save_dashboard_document

    def save_document_with_canonical_invalidation(
        repo_root: Path | str,
        document_id: str,
        *,
        content: str,
        revision: str,
    ) -> dict[str, Any]:
        result = original_save_document(
            repo_root,
            document_id,
            content=content,
            revision=revision,
        )
        root = Path(repo_root)
        parts = document_id.split(":")
        if len(parts) < 2:
            return result

        kind, change_set_id = parts[0], parts[1]
        change_path = root / "docs/changes/active" / f"{change_set_id}.md"
        if not change_path.exists():
            return result

        _sync_scoped_dashboard_session(root, change_set_id, dashboard)
        for stage_id in _canonical_stale_stage_ids(document_dashboard, kind):
            cli._record_procedure_stage_status(
                root,
                change_path.relative_to(root),
                document_dashboard.procedure_stage(stage_id),
                "stale",
                f"stale after dashboard edit of {kind}",
            )
        return result

    document_dashboard.save_dashboard_document = save_document_with_canonical_invalidation
    ui_server.save_dashboard_document = save_document_with_canonical_invalidation
    setattr(dashboard, _PATCHED_ATTR, True)


def _sync_scoped_dashboard_session(root: Path, change_set_id: str, dashboard: Any) -> None:
    session_path = (
        root / ".harness" / "ui" / "change-sets" / change_set_id / "harvest-session.json"
    )
    if not session_path.exists():
        return
    try:
        session = json.loads(session_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return
    if isinstance(session, dict):
        dashboard.sync_change_set_runtime_state(root, change_set_id, session)


def _canonical_ddd_substep_results(session: dict[str, Any]) -> dict[str, dict[str, dict[str, str]]] | None:
    state = session.get("ddd_architecture")
    if not isinstance(state, dict):
        return None

    results: dict[str, dict[str, dict[str, str]]] = {}
    for raw_uc_id in state.get("uc_ids", ()):
        uc_id = str(raw_uc_id)
        item = state.get("items", {}).get(uc_id, {})
        steps = item.get("steps", {}) if isinstance(item, dict) else {}
        if not isinstance(steps, dict):
            continue
        per_uc: dict[str, dict[str, str]] = {}
        for raw_step_id, raw_step in steps.items():
            if not isinstance(raw_step, dict):
                continue
            raw_status = str(raw_step.get("status") or "pending")
            per_uc[str(raw_step_id)] = {
                "status": _canonical_substep_status(raw_status),
                "ui_status": raw_status,
            }
        if per_uc:
            results[uc_id] = per_uc
    return results


def _canonical_substep_status(ui_status: str) -> str:
    normalized = ui_status.strip().lower()
    if normalized == "complete":
        return "verified"
    if normalized == "stale":
        return "stale"
    if normalized in {"error", "needs_input"}:
        return "blocked"
    return "pending"


def _canonical_stale_stage_ids(document_dashboard: Any, kind: str) -> tuple[str, ...]:
    """Return all dependency descendants, including integration-only stages."""

    existing = tuple(document_dashboard._stale_stage_ids(kind))
    additions = ("ddd-design-integration", "design-visualization")
    return tuple(dict.fromkeys((*existing, *additions)))
