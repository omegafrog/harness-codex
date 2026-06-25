"""Runtime compatibility patch for complete active ChangeSet deletion."""

from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.changeset_cleanup import purge_changeset_runtime_artifacts


_PATCHED = "_harness_changeset_deletion_runtime_cleanup_applied"


def apply_changeset_deletion_runtime_cleanup_patch() -> None:
    """Attach cleanup to the CLI and dashboard ChangeSet deletion boundaries."""

    _patch_dashboard_delete()
    _patch_dashboard_run_projection()
    _patch_cli_delete_when_available()


def _patch_dashboard_delete() -> None:
    from harness_codex.runtime import document_dashboard

    original_delete = document_dashboard.delete_active_changeset
    if getattr(original_delete, _PATCHED, False):
        return

    def delete_active_changeset_with_runtime_cleanup(
        repo_root: Path | str,
        change_set_id: str,
    ) -> dict[str, str]:
        result = original_delete(repo_root, change_set_id)
        purge_changeset_runtime_artifacts(repo_root, change_set_id)
        return result

    setattr(delete_active_changeset_with_runtime_cleanup, _PATCHED, True)
    document_dashboard.delete_active_changeset = delete_active_changeset_with_runtime_cleanup


def _patch_cli_delete_when_available() -> None:
    """Patch after ``harness_codex.cli`` has completed its module initialization."""

    from harness_codex import cli

    original_delete = getattr(cli, "changes_delete_command", None)
    if original_delete is None or getattr(original_delete, _PATCHED, False):
        return

    def changes_delete_command_with_runtime_cleanup(args, repo_root: Path) -> str:
        result = original_delete(args, repo_root)
        purge_changeset_runtime_artifacts(repo_root, args.change_set_id)
        return result

    setattr(changes_delete_command_with_runtime_cleanup, _PATCHED, True)
    cli.changes_delete_command = changes_delete_command_with_runtime_cleanup


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
