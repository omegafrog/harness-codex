"""Correct legacy dashboard bridges without restoring table/session authority.

This patch is deliberately installed after the legacy bridge.  The bridge remains
useful to bootstrap a missing canonical state, but it must never overwrite an
existing canonical stale/blocked decision from editable Markdown table rows or
scoped UI-session artifacts.
"""

from __future__ import annotations

from pathlib import Path


_PATCHED = "_harness_dashboard_harvest_consistency_patch_applied"


def apply_dashboard_harvest_consistency_patch() -> None:
    """Install canonical-first gate and snapshot compatibility corrections."""

    from harness_codex.runtime import dashboard_runtime_state as canonical
    from harness_codex.runtime import dashboard_runtime_state_legacy_bridge as bridge
    from harness_codex.runtime import harvest_ui, ui_server

    if getattr(bridge, _PATCHED, False):
        return

    original_migrate = bridge._migrate_scoped_ui_session
    original_hydrate = bridge._hydrate_verified_procedure_rows

    def migrate_only_when_canonical_state_is_missing(root: Path, change_set_id: str) -> None:
        if canonical.load_canonical_change_set_state(root, change_set_id) is not None:
            return
        original_migrate(root, change_set_id)

    def hydrate_only_when_canonical_state_is_missing(root: Path, change_set_id: str) -> None:
        if canonical.load_canonical_change_set_state(root, change_set_id) is not None:
            return
        original_hydrate(root, change_set_id)

    bridge._migrate_scoped_ui_session = migrate_only_when_canonical_state_is_missing
    bridge._hydrate_verified_procedure_rows = hydrate_only_when_canonical_state_is_missing

    original_copy = harvest_ui._copy_scoped_use_case_outputs

    def copy_only_session_accepted_event_outputs(root: Path, scoped_root: Path, session: dict) -> None:
        original_copy(root, scoped_root, session)
        event_items = (session.get("event_storming") or {}).get("items", {})
        target_root = scoped_root / harvest_ui.USE_CASE_SLICE_ROOT
        for uc_path in target_root.glob("UC-*"):
            item = event_items.get(uc_path.name, {}) if isinstance(event_items, dict) else {}
            if not isinstance(item, dict) or item.get("status") != "complete":
                (uc_path / "event-storming.md").unlink(missing_ok=True)

    harvest_ui._copy_scoped_use_case_outputs = copy_only_session_accepted_event_outputs

    original_harvest_save = harvest_ui.save_changeset_harvest_ui
    original_ui_save = ui_server.save_changeset_harvest_ui

    def ensure_recoverable_session(root: Path | str, change_set_id: str) -> None:
        root_path = Path(root)
        if harvest_ui._load_session(root_path) is not None:
            return
        session = harvest_ui._recover_changeset_session(root_path, change_set_id)
        harvest_ui._write_session(root_path, session)

    def save_harvest_snapshot_with_recovery(root: Path | str, change_set_id: str) -> None:
        ensure_recoverable_session(root, change_set_id)
        original_harvest_save(root, change_set_id)

    def save_ui_snapshot_with_recovery(root: Path | str, change_set_id: str) -> None:
        ensure_recoverable_session(root, change_set_id)
        original_ui_save(root, change_set_id)

    harvest_ui.save_changeset_harvest_ui = save_harvest_snapshot_with_recovery
    ui_server.save_changeset_harvest_ui = save_ui_snapshot_with_recovery
    setattr(bridge, _PATCHED, True)
