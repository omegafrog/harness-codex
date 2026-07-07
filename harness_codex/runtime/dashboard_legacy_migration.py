"""One-time migration for retired scoped dashboard state formats."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from harness_codex.runtime.state import RunStateStore


def migrate_legacy_dashboard_sessions(repo_root: Path | str) -> tuple[str, ...]:
    """Import old scoped UI progress before a dashboard or workflow starts.

    This preserves legacy data once without patching read endpoints, UI handlers,
    or gate functions at import time.
    """

    root = Path(repo_root)
    active = root / "docs/changes/active"
    if not active.exists():
        return ()

    from harness_codex.runtime import dashboard_runtime_state as canonical
    from harness_codex.runtime import dashboard_runtime_state_legacy_bridge as bridge
    from harness_codex.runtime import dashboard_runtime_state_legacy_compat as compat

    migrated: list[str] = []
    for path in sorted(active.glob("CHG-*.md")):
        change_set_id = path.stem
        before = canonical.load_canonical_change_set_state(root, change_set_id)
        bridge._migrate_scoped_ui_session(root, change_set_id)
        bridge._hydrate_verified_procedure_rows(root, change_set_id)
        _respect_explicit_language_gate(root, change_set_id, canonical, compat)
        after = canonical.load_canonical_change_set_state(root, change_set_id)
        if after is not None and after != before:
            migrated.append(change_set_id)
    return tuple(migrated)


def _respect_explicit_language_gate(root: Path, change_set_id: str, canonical, compat) -> None:
    if compat._explicit_language_gate(root, change_set_id) is not False:
        return
    state = canonical.load_canonical_change_set_state(root, change_set_id)
    if state is None:
        return
    legacy_artifact = next(
        (
            item
            for item in state.artifact_states
            if item.stage == "ubiquitous-language-definition"
            and item.generated_by == "legacy_scoped_ui"
        ),
        None,
    )
    if legacy_artifact is None:
        return
    RunStateStore(root).save(
        replace(
            state,
            artifact_states=tuple(
                item
                for item in state.artifact_states
                if item.stage != "ubiquitous-language-definition"
            ),
        )
    )
    compat._reset_language_table_row(root, change_set_id)
