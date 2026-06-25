"""Compatibility correction for old scoped dashboard sessions.

Early scoped sessions used ``requirements_gate_passed`` as the completion
marker for a combined requirements/language view.  New sessions persist the
separate ``language_gate_passed`` field.  Keep the old interpretation only
when that field is absent.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

from harness_codex.runtime.procedure_stages import PROCEDURE_STAGES, update_changeset_stage_status
from harness_codex.runtime.state import RunStateStore

_PATCHED = "_harness_dashboard_runtime_legacy_language_compat_applied"


def apply_dashboard_runtime_state_legacy_compat() -> None:
    """Prevent old-session migration from overriding an explicit false gate."""

    from harness_codex.runtime import dashboard_runtime_state as canonical
    from harness_codex.runtime import dashboard_runtime_state_legacy_bridge as bridge

    if getattr(bridge, _PATCHED, False):
        return

    original_migrate = bridge._migrate_scoped_ui_session

    def migrate_scoped_session_with_explicit_language_gate(root: Path, change_set_id: str) -> None:
        explicit_language_gate = _explicit_language_gate(root, change_set_id)
        original_migrate(root, change_set_id)
        if explicit_language_gate is not False:
            return

        state = canonical.load_canonical_change_set_state(root, change_set_id)
        if state is None:
            return
        legacy_language_artifact = next(
            (
                item
                for item in state.artifact_states
                if item.stage == "ubiquitous-language-definition"
                and item.generated_by == "legacy_scoped_ui"
            ),
            None,
        )
        if legacy_language_artifact is None:
            return

        updated = replace(
            state,
            artifact_states=tuple(
                item
                for item in state.artifact_states
                if item.stage != "ubiquitous-language-definition"
            ),
        )
        RunStateStore(root).save(updated)
        _reset_language_table_row(root, change_set_id)

    bridge._migrate_scoped_ui_session = migrate_scoped_session_with_explicit_language_gate
    setattr(bridge, _PATCHED, True)


def _explicit_language_gate(root: Path, change_set_id: str) -> bool | None:
    session_path = root / ".harness/ui/change-sets" / change_set_id / "harvest-session.json"
    try:
        session = json.loads(session_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(session, dict) or "language_gate_passed" not in session:
        return None
    return bool(session["language_gate_passed"])


def _reset_language_table_row(root: Path, change_set_id: str) -> None:
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not path.exists():
        return
    stage = next(
        item
        for item in PROCEDURE_STAGES
        if item.stage_id == "ubiquitous-language-definition"
    )
    text = path.read_text(encoding="utf-8")
    path.write_text(
        update_changeset_stage_status(text, stage=stage, status="pending", notes="-"),
        encoding="utf-8",
    )
