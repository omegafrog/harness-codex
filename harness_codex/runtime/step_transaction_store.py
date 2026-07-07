"""SQLite-backed durable transaction ledger for workflow steps."""

from __future__ import annotations

import hashlib
import sqlite3
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

from harness_codex.runtime.models import RunContext, Step, StepResult, StepStatus


SCHEMA_VERSION = 1
_DB_FILE_NAME = "state.sqlite3"


@dataclass(frozen=True)
class StepTransaction:
    transaction_id: int
    attempt: int


class StepTransactionStore:
    """The authoritative, append-only per-step state and artifact ledger for one run."""

    def __init__(self, repo_root: Path | str, run_id: str) -> None:
        self._path = Path(repo_root) / ".harness" / "runs" / run_id / _DB_FILE_NAME

    @property
    def path(self) -> Path:
        return self._path

    def begin(self, step: Step, context: RunContext) -> StepTransaction:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connection() as connection:
            self._initialize(connection)
            self._recover_interrupted(connection)
            with _transaction(connection):
                attempt = int(
                    connection.execute(
                        """
                        SELECT COALESCE(MAX(attempt), 0) + 1
                        FROM step_transactions
                        WHERE run_id = ? AND work_item_id = ? AND step_id = ?
                        """,
                        (context.run_id, _work_item_id(context), step.id),
                    ).fetchone()[0]
                )
                cursor = connection.execute(
                    """
                    INSERT INTO step_transactions (
                        run_id, workflow_name, change_set_id, work_item_id, step_id,
                        step_kind, attempt, state, result_status, started_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', 'running', ?)
                    """,
                    (
                        context.run_id,
                        context.workflow_name,
                        _change_set_id(context),
                        _work_item_id(context),
                        step.id,
                        step.kind.value,
                        attempt,
                        _now(),
                    ),
                )
                transaction_id = int(cursor.lastrowid)
                self._record_artifacts(
                    connection,
                    transaction_id,
                    context.repo_root,
                    step.inputs,
                    role="input",
                    phase="before",
                )
                self._record_artifacts(
                    connection,
                    transaction_id,
                    context.repo_root,
                    step.outputs,
                    role="output",
                    phase="before",
                )
                return StepTransaction(transaction_id=transaction_id, attempt=attempt)

    def finish(
        self,
        transaction: StepTransaction,
        step: Step,
        context: RunContext,
        result: StepResult,
    ) -> StepResult:
        final_result = result
        with self._connection() as connection:
            self._initialize(connection)
            with _transaction(connection):
                outputs = tuple(step.outputs)
                self._record_artifacts(
                    connection,
                    transaction.transaction_id,
                    context.repo_root,
                    outputs,
                    role="output",
                    phase="after",
                )
                self._record_changed_files(connection, transaction.transaction_id, context.repo_root)
                missing_outputs = _missing_outputs(context.repo_root, outputs)
                if result.status is StepStatus.SUCCEEDED and missing_outputs:
                    final_result = StepResult(
                        step_id=result.step_id,
                        status=StepStatus.FAILED,
                        exit_code=result.exit_code,
                        output_path=result.output_path,
                        error=(
                            "declared step outputs missing: "
                            + ", ".join(str(path) for path in missing_outputs)
                        ),
                        failure_kind=result.failure_kind,
                        metadata=dict(result.metadata),
                    )
                connection.execute(
                    """
                    UPDATE step_transactions
                    SET state = ?, result_status = ?, failure_kind = ?, error = ?, finished_at = ?
                    WHERE id = ?
                    """,
                    (
                        _transaction_state(final_result.status),
                        final_result.status.value,
                        final_result.failure_kind.value if final_result.failure_kind else None,
                        final_result.error,
                        _now(),
                        transaction.transaction_id,
                    ),
                )
        return final_result

    def _record_artifacts(
        self,
        connection: sqlite3.Connection,
        transaction_id: int,
        repo_root: Path,
        paths: Iterable[Path],
        *,
        role: str,
        phase: str,
    ) -> None:
        for path in paths:
            relative = Path(path)
            exists, kind, checksum, size_bytes = _artifact_facts(repo_root / relative)
            connection.execute(
                """
                INSERT INTO step_artifacts (
                    transaction_id, path, role, phase, exists_flag, kind, checksum, size_bytes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(transaction_id, path, role, phase) DO UPDATE SET
                    exists_flag = excluded.exists_flag,
                    kind = excluded.kind,
                    checksum = excluded.checksum,
                    size_bytes = excluded.size_bytes
                """,
                (
                    transaction_id,
                    str(relative),
                    role,
                    phase,
                    int(exists),
                    kind,
                    checksum,
                    size_bytes,
                ),
            )

    def _record_changed_files(
        self,
        connection: sqlite3.Connection,
        transaction_id: int,
        repo_root: Path,
    ) -> None:
        for path in _changed_files(repo_root):
            exists, kind, checksum, size_bytes = _artifact_facts(repo_root / path)
            connection.execute(
                """
                INSERT INTO step_artifacts (
                    transaction_id, path, role, phase, exists_flag, kind, checksum, size_bytes
                ) VALUES (?, ?, 'changed_file', 'after', ?, ?, ?, ?)
                ON CONFLICT(transaction_id, path, role, phase) DO UPDATE SET
                    exists_flag = excluded.exists_flag,
                    kind = excluded.kind,
                    checksum = excluded.checksum,
                    size_bytes = excluded.size_bytes
                """,
                (transaction_id, str(path), int(exists), kind, checksum, size_bytes),
            )

    @contextmanager
    def _connection(self):
        connection = sqlite3.connect(self._path)
        try:
            connection.execute("PRAGMA foreign_keys = ON")
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = FULL")
            yield connection
        finally:
            connection.close()

    @staticmethod
    def _initialize(connection: sqlite3.Connection) -> None:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS step_transactions (
                id INTEGER PRIMARY KEY,
                run_id TEXT NOT NULL,
                workflow_name TEXT NOT NULL,
                change_set_id TEXT,
                work_item_id TEXT,
                step_id TEXT NOT NULL,
                step_kind TEXT NOT NULL,
                attempt INTEGER NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('RUNNING', 'COMMITTED', 'FAILED', 'BLOCKED', 'SKIPPED', 'INTERRUPTED')),
                result_status TEXT NOT NULL,
                failure_kind TEXT,
                error TEXT,
                started_at TEXT NOT NULL,
                finished_at TEXT,
                UNIQUE(run_id, work_item_id, step_id, attempt)
            );
            CREATE TABLE IF NOT EXISTS step_artifacts (
                transaction_id INTEGER NOT NULL REFERENCES step_transactions(id) ON DELETE CASCADE,
                path TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('input', 'output', 'changed_file')),
                phase TEXT NOT NULL CHECK(phase IN ('before', 'after')),
                exists_flag INTEGER NOT NULL CHECK(exists_flag IN (0, 1)),
                kind TEXT NOT NULL,
                checksum TEXT,
                size_bytes INTEGER,
                PRIMARY KEY(transaction_id, path, role, phase)
            );
            CREATE INDEX IF NOT EXISTS idx_step_transactions_run ON step_transactions(run_id, id);
            CREATE INDEX IF NOT EXISTS idx_step_artifacts_transaction ON step_artifacts(transaction_id);
            """
        )
        connection.execute(
            "INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )
        connection.commit()

    @staticmethod
    def _recover_interrupted(connection: sqlite3.Connection) -> None:
        connection.execute(
            """
            UPDATE step_transactions
            SET state = 'INTERRUPTED', result_status = 'blocked',
                error = COALESCE(error, 'runtime stopped before step transaction committed'),
                finished_at = COALESCE(finished_at, ?)
            WHERE state = 'RUNNING'
            """,
            (_now(),),
        )
        connection.commit()


def _transaction_state(status: StepStatus) -> str:
    return {
        StepStatus.SUCCEEDED: "COMMITTED",
        StepStatus.FAILED: "FAILED",
        StepStatus.BLOCKED: "BLOCKED",
        StepStatus.SKIPPED: "SKIPPED",
        StepStatus.PENDING: "INTERRUPTED",
        StepStatus.RUNNING: "RUNNING",
    }[status]


def _artifact_facts(path: Path) -> tuple[bool, str, str | None, int | None]:
    try:
        if path.is_file():
            payload = path.read_bytes()
            return True, "file", hashlib.sha256(payload).hexdigest(), len(payload)
        if path.is_dir():
            return True, "directory", _directory_checksum(path), None
    except OSError:
        return False, "missing", None, None
    return False, "missing", None, None


def _directory_checksum(path: Path) -> str:
    digest = hashlib.sha256()
    for child in sorted(item for item in path.rglob("*") if item.is_file()):
        relative = child.relative_to(path).as_posix().encode("utf-8")
        digest.update(relative)
        digest.update(b"\0")
        try:
            digest.update(hashlib.sha256(child.read_bytes()).digest())
        except OSError:
            digest.update(b"<unreadable>")
    return digest.hexdigest()


def _changed_files(repo_root: Path) -> tuple[Path, ...]:
    import subprocess

    completed = subprocess.run(
        ["git", "status", "--porcelain=v1", "-z"],
        cwd=repo_root,
        text=False,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        return ()
    entries = [entry for entry in completed.stdout.split(b"\0") if entry]
    paths: list[Path] = []
    skip_rename_source = False
    for entry in entries:
        if skip_rename_source:
            paths.append(Path(entry.decode("utf-8", errors="replace")))
            skip_rename_source = False
            continue
        if len(entry) < 4:
            continue
        status = entry[:2]
        paths.append(Path(entry[3:].decode("utf-8", errors="replace")))
        if b"R" in status or b"C" in status:
            skip_rename_source = True
    return tuple(dict.fromkeys(paths))


def _missing_outputs(repo_root: Path, outputs: Iterable[Path]) -> tuple[Path, ...]:
    return tuple(path for path in outputs if not (repo_root / path).exists())


def _change_set_id(context: RunContext) -> str | None:
    value = context.metadata.get("change_set_id")
    return str(value) if value not in (None, "") else None


def _work_item_id(context: RunContext) -> str:
    value = context.metadata.get("active_work_item_id")
    return str(value) if value not in (None, "") else "-"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@contextmanager
def _transaction(connection: sqlite3.Connection):
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        connection.rollback()
        raise
    else:
        connection.commit()
