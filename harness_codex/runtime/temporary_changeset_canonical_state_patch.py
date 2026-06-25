"""Move canonical RunState when a temporary ChangeSet receives its final ID."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path


def apply_temporary_changeset_canonical_state_patch() -> None:
    """Keep one canonical state when ``CHG-TEMP-*`` is finalized."""

    try:
        from harness_codex import cli
        from harness_codex.runtime import dashboard_runtime_state as dashboard
        from harness_codex.runtime.state import RunStateStore
    except ImportError:
        return

    if not hasattr(cli, "_finalize_temporary_changeset"):
        return
    if getattr(cli, "_temporary_changeset_canonical_state_patch_applied", False):
        return

    original = cli._finalize_temporary_changeset

    def finalize_with_canonical_state(
        repo_root: Path,
        *,
        change_set_id: str,
        run_id: str,
        include_design_use_cases: bool = False,
    ):
        previous_state = dashboard.load_canonical_change_set_state(repo_root, change_set_id)
        result = original(
            repo_root,
            change_set_id=change_set_id,
            run_id=run_id,
            include_design_use_cases=include_design_use_cases,
        )
        if result is None or previous_state is None:
            return result

        final_id, _final_path = result
        if final_id == change_set_id:
            return result

        store = RunStateStore(repo_root)
        final_state = replace(
            previous_state,
            run_id=dashboard.canonical_run_id(final_id),
            change_set_id=final_id,
        )
        store.save(final_state)
        old_state_path = store.state_path(dashboard.canonical_run_id(change_set_id))
        if old_state_path.exists():
            old_state_path.unlink()
        dashboard.reconcile_change_set_procedure_table(repo_root, final_state)
        return result

    cli._finalize_temporary_changeset = finalize_with_canonical_state
    cli._temporary_changeset_canonical_state_patch_applied = True
