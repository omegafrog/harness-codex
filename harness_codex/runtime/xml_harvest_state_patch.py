"""Install XML-only persistence beneath the harvest UI API.

This early installer deliberately imports only ``harvest_ui``. It runs before
legacy dashboard wrappers are installed so those wrappers capture XML-backed
functions rather than JSON snapshot writers.
"""

from __future__ import annotations

from contextvars import ContextVar
from copy import deepcopy
from pathlib import Path
from typing import Any

from harness_codex.runtime.xml_ui_state import load_ui_session, save_ui_session

_PATCHED_ATTR = "_harness_xml_harvest_state_patch_applied"
_CONTEXT: ContextVar[tuple[Path, str] | None] = ContextVar("harness_xml_harvest_context", default=None)
_EPHEMERAL: dict[Path, dict[str, Any]] = {}


def activate_harvest_xml_context(repo_root: Path | str, change_set_id: str) -> None:
    _CONTEXT.set((Path(repo_root).resolve(), change_set_id))


def apply_xml_harvest_state_patch() -> None:
    """Remove durable JSON reads and writes from harvest session functions."""

    from harness_codex.runtime import harvest_ui

    if getattr(harvest_ui, _PATCHED_ATTR, False):
        return

    def current(root: Path | str) -> tuple[Path, str] | None:
        value = _CONTEXT.get()
        return value if value and value[0] == Path(root).resolve() else None

    def write_session(root: Path, session: dict[str, Any]) -> None:
        context = current(root)
        if context is None:
            _EPHEMERAL[Path(root).resolve()] = deepcopy(session)
            return
        save_ui_session(context[0], context[1], session)

    def load_session(root: Path) -> dict[str, Any] | None:
        context = current(root)
        if context is None:
            value = _EPHEMERAL.get(Path(root).resolve())
            return deepcopy(value) if value is not None else None
        return load_ui_session(context[0], context[1])

    def load_changeset(root: Path | str, change_set_id: str):
        root_path = Path(root).resolve()
        harvest_ui._require_active_changeset(root_path, change_set_id)
        activate_harvest_xml_context(root_path, change_set_id)
        session = load_ui_session(root_path, change_set_id)
        if session is None:
            session = harvest_ui._recover_changeset_session(root_path, change_set_id)
        harvest_ui._normalize_session(session)
        harvest_ui._sync_use_case_readiness(root_path, session)
        harvest_ui._normalize_resumed_stage(session)
        save_ui_session(root_path, change_set_id, session)
        return harvest_ui._result(root_path, session)

    def save_changeset(root: Path | str, change_set_id: str) -> None:
        root_path = Path(root).resolve()
        harvest_ui._require_active_changeset(root_path, change_set_id)
        activate_harvest_xml_context(root_path, change_set_id)
        session = harvest_ui._load_session(root_path)
        if session is None:
            raise ValueError("harvest session has not started")
        save_ui_session(root_path, change_set_id, session)

    def activate_changeset(root: Path | str, change_set_id: str) -> None:
        root_path = Path(root).resolve()
        activate_harvest_xml_context(root_path, change_set_id)
        load_changeset(root_path, change_set_id)

    harvest_ui._write_session = write_session
    harvest_ui._load_session = load_session
    harvest_ui.load_changeset_harvest_ui = load_changeset
    harvest_ui.save_changeset_harvest_ui = save_changeset
    harvest_ui.activate_changeset_harvest_ui = activate_changeset
    setattr(harvest_ui, _PATCHED_ATTR, True)
