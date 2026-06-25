"""Ensure activating one ChangeSet cannot inherit another ChangeSet's UC slices."""

from __future__ import annotations

from pathlib import Path


_PATCHED = "_harness_changeset_scope_isolation_patch_applied"


def apply_changeset_scope_isolation_patch() -> None:
    """Replace the global UC worktree from the selected ChangeSet snapshot.

    ``activate_changeset_harvest_ui`` used to copy scoped UC documents with
    ``replace=False``. A newly created ChangeSet has no scoped UC tree yet, so
    stale ``docs/use-cases`` directories from a deleted ChangeSet survived and
    could be considered by subsequent agent runs. The global worktree is only a
    materialized view of the active ChangeSet snapshot; it must be replaced, not
    merged.
    """

    from harness_codex.runtime import harvest_ui

    original_activate = harvest_ui.activate_changeset_harvest_ui
    if getattr(original_activate, _PATCHED, False):
        return

    def activate_changeset_harvest_ui_with_isolated_use_cases(
        root: Path | str,
        change_set_id: str,
    ) -> None:
        root_path = Path(root)
        original_activate(root_path, change_set_id)

        scoped_root = root_path / harvest_ui.CHANGESET_SESSION_ROOT / change_set_id
        scoped_slices = scoped_root / harvest_ui.USE_CASE_SLICE_ROOT
        active_slices = root_path / harvest_ui.USE_CASE_SLICE_ROOT
        harvest_ui._copy_optional_tree(scoped_slices, active_slices, replace=True)

    setattr(activate_changeset_harvest_ui_with_isolated_use_cases, _PATCHED, True)
    harvest_ui.activate_changeset_harvest_ui = activate_changeset_harvest_ui_with_isolated_use_cases

    # ui_server holds a direct import, so repair that binding too.
    from harness_codex.runtime import ui_server

    ui_server.activate_changeset_harvest_ui = activate_changeset_harvest_ui_with_isolated_use_cases
