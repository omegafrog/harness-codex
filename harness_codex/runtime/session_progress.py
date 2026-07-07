"""Explicit durable-ledger progress reporting for a ChangeSet session."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from threading import Event, Thread
from time import monotonic
from typing import Callable, Mapping

DEFAULT_PROGRESS_INTERVAL_SECONDS = 30.0


@dataclass
class StepLedgerProgressReporter:
    """Emit periodic progress without replacing coordinator functions."""

    repo_root: Path
    run_id: str
    emit: Callable[[str], None]
    interval_seconds: float = DEFAULT_PROGRESS_INTERVAL_SECONDS

    def __post_init__(self) -> None:
        self._stop = Event()
        self._started_at = 0.0
        self._thread: Thread | None = None

    def __enter__(self) -> "StepLedgerProgressReporter":
        self._started_at = monotonic()
        self._thread = Thread(target=self._report_until_stopped, name="harness-progress-feedback", daemon=True)
        self._thread.start()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join()
            self._thread = None

    def _report_until_stopped(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            active = active_step(self.repo_root, self.run_id)
            if active is None:
                continue
            elapsed = max(0, int(monotonic() - self._started_at))
            self.emit(
                f"진행 중: ChangeSet {active.get('change_set_id') or '-'}, "
                f"Work item {active.get('work_item_id') or '-'}, "
                f"step={active.get('step_id') or '-'} ({elapsed}초 경과)"
            )


def active_step(repo_root: Path | str, run_id: str) -> Mapping[str, str | None] | None:
    """Read an XML transaction ledger first, with SQLite as legacy fallback."""

    root = Path(repo_root)
    xml = _active_xml_step(root, run_id)
    return xml if xml is not None else _active_sqlite_step(root, run_id)


def _active_xml_step(root: Path, run_id: str) -> Mapping[str, str | None] | None:
    try:
        from harness_codex.runtime.state import RunStateStore

        state = RunStateStore(root).load(run_id)
    except (FileNotFoundError, KeyError, TypeError, ValueError, OSError):
        return None
    ledger = state.decision_results.get("xml_step_ledger")
    if not isinstance(ledger, dict):
        return None
    entries = ledger.get("entries")
    if not isinstance(entries, list):
        return None
    for entry in reversed(entries):
        if not isinstance(entry, dict) or entry.get("state") != "RUNNING":
            continue
        return {
            "change_set_id": _text(entry.get("change_set_id")),
            "work_item_id": _text(entry.get("work_item_id")),
            "step_id": _text(entry.get("step_id")),
        }
    return None


def _active_sqlite_step(root: Path, run_id: str) -> Mapping[str, str | None] | None:
    path = root / ".harness/runs" / run_id / "state.sqlite3"
    if not path.exists():
        return None
    try:
        with sqlite3.connect(path, timeout=1) as connection:
            row = connection.execute(
                """SELECT change_set_id, work_item_id, step_id
                   FROM step_transactions WHERE state = 'RUNNING'
                   ORDER BY id DESC LIMIT 1"""
            ).fetchone()
    except (OSError, sqlite3.DatabaseError):
        return None
    if row is None:
        return None
    return {"change_set_id": row[0], "work_item_id": row[1], "step_id": row[2]}


def _text(value: object) -> str | None:
    return str(value) if value not in (None, "") else None
