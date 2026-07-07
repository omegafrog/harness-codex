"""Install XML-only persistence beneath the harvest UI API.

This early installer deliberately imports only ``harvest_ui``. It runs before
legacy dashboard wrappers are installed so those wrappers capture XML-backed
functions rather than JSON snapshot writers.
"""

from __future__ import annotations

import shutil
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


def copy_harvest_evidence(
    harvest_ui,
    root: Path,
    change_set_id: str,
    session: dict[str, Any],
) -> None:
    """Keep generated documents available to the UI without persisting state.

    The scoped directory contains only document copies. It never contains
    `harvest-session.json`, workflow state, or any status-bearing metadata.
    """

    scoped_root = harvest_ui._changeset_session_root(root, change_set_id)
    scoped_root.mkdir(parents=True, exist_ok=True)
    (scoped_root / "harvest-session.json").unlink(missing_ok=True)
    for artifact in (
        harvest_ui.REQUIREMENTS_PATH,
        harvest_ui.UBIQUITOUS_LANGUAGE_PATH,
        harvest_ui.CONTEXT_PATH,
    ):
        harvest_ui._copy_optional_artifact(root / artifact, scoped_root / artifact)

    use_cases_started = (
        session.get("active_stage") == "useCases"
        or session.get("use_cases_ready")
        or session.get("use_case_current_question")
        or session.get("use_case_clarifications")
        or isinstance(session.get("event_storming"), dict)
        or isinstance(session.get("ddd_architecture"), dict)
    )
    if not use_cases_started:
        (scoped_root / harvest_ui.USE_CASES_PATH).unlink(missing_ok=True)
        shutil.rmtree(scoped_root / harvest_ui.USE_CASE_SLICE_ROOT, ignore_errors=True)
        return

    harvest_ui._copy_optional_artifact(
        root / harvest_ui.USE_CASES_PATH,
        scoped_root / harvest_ui.USE_CASES_PATH,
    )
    harvest_ui._copy_scoped_use_case_outputs(root, scoped_root, session)
    if isinstance(session.get("ddd_architecture"), dict):
        harvest_ui._copy_optional_artifact(
            root / "ARCHITECTURE.md",
            scoped_root / "ARCHITECTURE.md",
        )


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
        copy_harvest_evidence(harvest_ui, context[0], context[1], session)

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
        copy_harvest_evidence(harvest_ui, root_path, change_set_id, session)
        return harvest_ui._result(root_path, session, artifact_root=harvest_ui._changeset_session_root(root_path, change_set_id))

    def save_changeset(root: Path | str, change_set_id: str) -> None:
        root_path = Path(root).resolve()
        harvest_ui._require_active_changeset(root_path, change_set_id)
        activate_harvest_xml_context(root_path, change_set_id)
        session = harvest_ui._load_session(root_path)
        if session is None:
            raise ValueError("harvest session has not started")
        save_ui_session(root_path, change_set_id, session)
        copy_harvest_evidence(harvest_ui, root_path, change_set_id, session)

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
