"""Replace persisted UI JSON sessions and rerun jobs with ChangeSet XML state."""

from __future__ import annotations

from contextvars import ContextVar
from copy import deepcopy
from pathlib import Path
from typing import Any

from harness_codex.runtime.xml_ui_state import (
    load_stage_rerun_job,
    load_ui_session,
    save_stage_rerun_job,
    save_ui_session,
)

_PATCHED_ATTR = "_harness_xml_ui_state_patch_applied"
_CONTEXT: ContextVar[tuple[Path, str] | None] = ContextVar("harness_xml_ui_context", default=None)
_EPHEMERAL_SESSIONS: dict[Path, dict[str, Any]] = {}


def activate_xml_ui_context(repo_root: Path | str, change_set_id: str) -> None:
    """Bind a request/thread to a ChangeSet-owned XML UI state document."""

    _CONTEXT.set((Path(repo_root).resolve(), change_set_id))


def apply_xml_ui_state_patch() -> None:
    """Make UI persistence XML-only while preserving public UI commands."""

    from harness_codex.runtime import harvest_ui, ui_server

    if getattr(harvest_ui, _PATCHED_ATTR, False):
        return

    def context_for(root: Path | str) -> tuple[Path, str] | None:
        context = _CONTEXT.get()
        normalized = Path(root).resolve()
        if context and context[0] == normalized:
            return context
        return None

    def write_session(root: Path, session: dict[str, Any]) -> None:
        context = context_for(root)
        if context is None:
            # A standalone pre-ChangeSet wizard can remain in memory for the
            # current process, but it never writes a second durable JSON state.
            _EPHEMERAL_SESSIONS[Path(root).resolve()] = deepcopy(session)
            return
        save_ui_session(context[0], context[1], session)

    def load_session(root: Path) -> dict[str, Any] | None:
        context = context_for(root)
        if context is None:
            value = _EPHEMERAL_SESSIONS.get(Path(root).resolve())
            return deepcopy(value) if value is not None else None
        return load_ui_session(context[0], context[1])

    def load_changeset(root: Path | str, change_set_id: str):
        root_path = Path(root).resolve()
        harvest_ui._require_active_changeset(root_path, change_set_id)
        activate_xml_ui_context(root_path, change_set_id)
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
        activate_xml_ui_context(root_path, change_set_id)
        session = harvest_ui._load_session(root_path)
        if session is None:
            raise ValueError("harvest session has not started")
        save_ui_session(root_path, change_set_id, session)

    def activate_changeset(root: Path | str, change_set_id: str) -> None:
        root_path = Path(root).resolve()
        activate_xml_ui_context(root_path, change_set_id)
        load_changeset(root_path, change_set_id)

    def start_requirements_changeset(repo_root: Path | str, prompt: str) -> dict[str, Any]:
        root = Path(repo_root).resolve()
        normalized_prompt = prompt.strip()
        if not normalized_prompt:
            raise ValueError("initial prompt is required")
        change_set_id = ui_server._suggest_change_set_id(root)
        path = root / "docs/changes/active" / f"{change_set_id}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            ui_server.render_initial_changeset(
                change_set_id=change_set_id,
                title=normalized_prompt.splitlines()[0][:80],
                request_summary=normalized_prompt,
            ),
            encoding="utf-8",
        )
        activate_xml_ui_context(root, change_set_id)
        result = harvest_ui.start_requirements(root, normalized_prompt)
        save_ui_session(root, change_set_id, harvest_ui._load_session(root) or {})
        return {"change_set_id": change_set_id, "harvest": result.as_dict()}

    def save_stage_job(root: Path, job: dict[str, Any]) -> None:
        change_set_id = str(job.get("change_set_id", ""))
        if not change_set_id:
            raise ValueError("stage rerun job requires change_set_id")
        save_stage_rerun_job(root.resolve(), change_set_id, job)

    def load_stage_job(root: Path, change_set_id: str) -> dict[str, Any] | None:
        return load_stage_rerun_job(root.resolve(), change_set_id)

    def no_legacy_stage_session(_root: Path, _change_set_id: str) -> None:
        return None

    harvest_ui._write_session = write_session
    harvest_ui._load_session = load_session
    harvest_ui.load_changeset_harvest_ui = load_changeset
    harvest_ui.save_changeset_harvest_ui = save_changeset
    harvest_ui.activate_changeset_harvest_ui = activate_changeset
    setattr(harvest_ui, _PATCHED_ATTR, True)

    # ui_server imports these functions directly, so rebind its references.
    ui_server.load_changeset_harvest_ui = load_changeset
    ui_server.save_changeset_harvest_ui = save_changeset
    ui_server.activate_changeset_harvest_ui = activate_changeset
    ui_server.start_requirements_changeset = start_requirements_changeset
    ui_server._save_stage_rerun_job = save_stage_job
    ui_server._load_stage_rerun_job = load_stage_job
    ui_server._load_latest_needs_input_stage_session = no_legacy_stage_session
