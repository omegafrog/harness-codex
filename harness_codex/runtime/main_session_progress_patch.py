"""Render SQLite-backed step transactions as periodic main-session feedback."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from threading import Event, Thread
from time import monotonic
from typing import Any, Mapping
from uuid import uuid4


PROGRESS_INTERVAL_SECONDS = 30.0


def apply_main_session_progress_feedback_patch() -> None:
    """Report the authoritative SQLite ``RUNNING`` step while a run executes."""

    import harness_codex.runtime.changeset_orchestrator as orchestrator

    original_apply_workflow = orchestrator.apply_workflow
    if getattr(original_apply_workflow, "_main_session_progress_feedback", False):
        return

    def apply_workflow_with_progress(*args, **kwargs):
        emit = kwargs.get("emit")
        if not callable(emit):
            return original_apply_workflow(*args, **kwargs)

        repo_root = _repo_root(args, kwargs)
        run_id = str(kwargs.get("run_id") or f"run-{uuid4().hex[:12]}")
        if kwargs.get("run_id") != run_id:
            kwargs = {**kwargs, "run_id": run_id}

        started_at = monotonic()
        stop = Event()
        reporter = Thread(
            target=_report_progress_until_stopped,
            args=(stop, emit, repo_root, run_id, started_at),
            name="harness-progress-feedback",
            daemon=True,
        )
        reporter.start()
        try:
            return original_apply_workflow(*args, **kwargs)
        finally:
            stop.set()
            reporter.join()

    apply_workflow_with_progress._main_session_progress_feedback = True
    orchestrator.apply_workflow = apply_workflow_with_progress


def _report_progress_until_stopped(
    stop: Event,
    emit,
    repo_root: Path,
    run_id: str,
    started_at: float,
) -> None:
    while not stop.wait(PROGRESS_INTERVAL_SECONDS):
        message = _progress_message(repo_root, run_id, monotonic() - started_at)
        if message is not None:
            emit(message)


def _repo_root(args: tuple[object, ...], kwargs: Mapping[str, Any]) -> Path:
    if "repo_root" in kwargs:
        return Path(kwargs["repo_root"])
    if args:
        return Path(args[0])
    raise TypeError("apply_workflow requires repo_root")


def _progress_message(repo_root: Path, run_id: str, elapsed_seconds: float) -> str | None:
    active = _active_step_row(repo_root, run_id)
    if active is None:
        return None

    elapsed = max(0, int(elapsed_seconds))
    return (
        f"진행 중: ChangeSet {active['change_set_id'] or '-'}, "
        f"Work item {active['work_item_id'] or '-'}, "
        f"step={active['step_id']} ({elapsed}초 경과)"
    )


def _active_step_row(repo_root: Path, run_id: str) -> Mapping[str, str | None] | None:
    path = repo_root / ".harness" / "runs" / run_id / "state.sqlite3"
    if not path.exists():
        return None
    try:
        with sqlite3.connect(path, timeout=1) as connection:
            row = connection.execute(
                """
                SELECT change_set_id, work_item_id, step_id
                FROM step_transactions
                WHERE state = 'RUNNING'
                ORDER BY id DESC
                LIMIT 1
                """
            ).fetchone()
    except (OSError, sqlite3.DatabaseError):
        return None
    if row is None:
        return None
    return {
        "change_set_id": row[0],
        "work_item_id": row[1],
        "step_id": row[2],
    }
