"""Runtime compatibility patch for complete active ChangeSet deletion."""

from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.changeset_cleanup import purge_changeset_runtime_artifacts


_PATCHED = "_harness_changeset_deletion_runtime_cleanup_applied"


def apply_changeset_deletion_runtime_cleanup_patch() -> None:
    """Make every active-ChangeSet unlink discard its resumable runtime state.

    Both the legacy CLI and the document dashboard delete the active ChangeSet
    markdown through ``Path.unlink``.  Keeping the boundary here guarantees the
    same cleanup semantics while those callers continue to share their existing
    validation and response contracts.
    """

    if getattr(Path, _PATCHED, False):
        return

    original_unlink = Path.unlink

    def unlink_with_changeset_runtime_cleanup(self: Path, missing_ok: bool = False) -> None:
        cleanup_target = _active_changeset_target(self)
        original_unlink(self, missing_ok=missing_ok)
        if cleanup_target is None:
            return
        repo_root, change_set_id = cleanup_target
        purge_changeset_runtime_artifacts(repo_root, change_set_id)

    Path.unlink = unlink_with_changeset_runtime_cleanup
    _patch_dashboard_run_projection()
    setattr(Path, _PATCHED, True)


def _active_changeset_target(path: Path) -> tuple[Path, str] | None:
    absolute = path.resolve()
    if (
        absolute.suffix != ".md"
        or absolute.parent.name != "active"
        or absolute.parent.parent.name != "changes"
        or absolute.parent.parent.parent.name != "docs"
        or not absolute.stem.startswith("CHG-")
    ):
        return None
    return absolute.parents[3], absolute.stem


def _patch_dashboard_run_projection() -> None:
    """Hide historical run files whose ChangeSet document has been deleted."""

    from harness_codex.runtime import dashboard as dashboard_module

    original_load_dashboard_runs = dashboard_module.load_dashboard_runs
    if getattr(original_load_dashboard_runs, _PATCHED, False):
        return

    def load_dashboard_runs_with_existing_changesets(repo_root: Path | str):
        root = Path(repo_root)
        known_change_set_ids = {
            path.stem
            for lifecycle in ("active", "completed")
            for path in (root / "docs" / "changes" / lifecycle).glob("CHG-*.md")
        }
        return tuple(
            run
            for run in original_load_dashboard_runs(root)
            if run.change_set_id in known_change_set_ids
        )

    setattr(load_dashboard_runs_with_existing_changesets, _PATCHED, True)
    dashboard_module.load_dashboard_runs = load_dashboard_runs_with_existing_changesets

    # document_dashboard imported the function directly, so repair that binding
    # as well when it was loaded before this patch.
    from harness_codex.runtime import document_dashboard

    document_dashboard.load_dashboard_runs = load_dashboard_runs_with_existing_changesets
