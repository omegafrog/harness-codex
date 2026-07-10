"""Durable orchestration session lock and checkpoint storage."""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


TERMINAL_STATUSES = frozenset({"succeeded", "failed", "blocked", "cancelled"})


class OrchestrationSessionBusy(RuntimeError):
    """Raised when another process owns one orchestration session lock."""


@dataclass
class OrchestrationSessionLease:
    session_dir: Path
    _handle: Any

    @property
    def checkpoint_path(self) -> Path:
        return self.session_dir / "checkpoint.json"

    def load(self) -> dict[str, Any]:
        try:
            value = json.loads(self.checkpoint_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def checkpoint(self, payload: Mapping[str, Any]) -> None:
        _atomic_json_write(self.checkpoint_path, payload)

    def close(self) -> None:
        try:
            fcntl.flock(self._handle.fileno(), fcntl.LOCK_UN)
        finally:
            self._handle.close()


class OrchestrationSessionStore:
    """Persist one session checkpoint and enforce process-level exclusivity."""

    def __init__(self, repo_root: Path | str, session_id: str) -> None:
        self.repo_root = Path(repo_root).resolve()
        self.session_id = session_id
        self.session_dir = self.repo_root / ".harness" / "orchestration" / session_id
        self.lock_path = self.session_dir / "session.lock"

    @staticmethod
    def fingerprint(repo_root: Path | str, instruction: str) -> str:
        value = f"{Path(repo_root).resolve()}\0{instruction.strip()}".encode("utf-8")
        return hashlib.sha256(value).hexdigest()

    def read_checkpoint(self) -> dict[str, Any]:
        try:
            value = json.loads((self.session_dir / "checkpoint.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return value if isinstance(value, dict) else {}

    def acquire(self) -> OrchestrationSessionLease:
        self.session_dir.mkdir(parents=True, exist_ok=True)
        handle = self.lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            handle.close()
            raise OrchestrationSessionBusy(self.session_id) from exc
        return OrchestrationSessionLease(self.session_dir, handle)


def _atomic_json_write(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".checkpoint-", suffix=".json", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


__all__ = [
    "OrchestrationSessionBusy",
    "OrchestrationSessionLease",
    "OrchestrationSessionStore",
    "TERMINAL_STATUSES",
]
