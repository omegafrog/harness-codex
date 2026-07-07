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
    """Emit periodic feedback while a session is executing.

    The reporter is a caller-owned collaborator. It never replaces coordinator
    functions and it reads the engine-owned SQLite step ledger only for display.
    """

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
        self._thread = Thread(
            target=self._report_until_stopped,
            name="harness-progress-feedback",
            daemon=True,
        )
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
                f"진행 중: ChangeSet {active['change_set_id'] or '-'}, "
                f"Work item {active['work_item_id'] or '-'}, "
                f"step={active['step_id']} ({elapsed}초 경과)"
            )


def active_step(repo_root: Path | str, run_id: str) -> Mapping[str, str | None] | None:
    """Return the current durable step-transaction row for presentation."""

    path = Path(repo_root) / ".harness/runs" / run_id / "state.sqlite3"
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
