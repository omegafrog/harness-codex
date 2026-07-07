"""Transactional mutation support for one canonical ChangeSet XML document.

A workflow command never holds a state lock while it executes.  Its intent
transition and outcome transition each commit as one serializable XML
replacement.  Every non-canonical run update also refreshes the canonical
ChangeSet projection in that same document replacement.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator
from xml.etree import ElementTree as ET

from harness_codex.runtime import xml_state


class XmlChangeSetTransaction:
    """A locked, validate-before-commit mutation of one ChangeSet document."""

    def __init__(self, repo_root: Path | str, change_set_id: str) -> None:
        self.repo_root = Path(repo_root)
        self.change_set_id = change_set_id
        self.path = xml_state.change_set_state_path(self.repo_root, change_set_id)
        self._root: ET.Element | None = None

    def load_run_state(self, run_id: str):
        """Return the latest in-transaction RunState, if it exists."""

        if self._root is None:
            raise RuntimeError("XML transaction is not active")
        runs = xml_state._single_child(self._root, "runs", required=True)
        for element in runs:
            if xml_state._local(element) == "run-state" and element.get("runId") == run_id:
                return xml_state.run_state_from_element(element)
        return None

    def save_run_state(self, state) -> None:
        """Upsert execution state and canonical projection in one transaction."""

        if self._root is None:
            raise RuntimeError("XML transaction is not active")
        if state.change_set_id != self.change_set_id:
            raise ValueError("RunState ChangeSet id does not match XML transaction")
        self._upsert(state)

        from harness_codex.runtime import dashboard_runtime_state as canonical

        canonical_run_id = canonical.canonical_run_id(self.change_set_id)
        if state.run_id == canonical_run_id:
            return
        current = self.load_run_state(canonical_run_id)
        canonical_state = canonical._build_canonical_state(
            change_set_id=self.change_set_id,
            affected_use_cases=state.affected_use_cases,
            affected_work_items=state.affected_work_items,
            current=current,
            artifacts={item.stage: item for item in state.artifact_states},
            incoming=state,
        )
        self._upsert(canonical_state)

    def _upsert(self, state) -> None:
        if self._root is None:
            raise RuntimeError("XML transaction is not active")
        runs = xml_state._single_child(self._root, "runs", required=True)
        replacement = xml_state.run_state_to_element(state)
        for existing in list(runs):
            if existing.get("runId") == state.run_id:
                runs.remove(existing)
                break
        runs.append(replacement)
        xml_state._sort_runs(runs)


@contextmanager
def change_set_transaction(
    repo_root: Path | str,
    change_set_id: str,
) -> Iterator[XmlChangeSetTransaction]:
    """Serialize one read-modify-write cycle for a ChangeSet XML document."""

    from harness_codex.runtime.xml_ui_state import install_xml_ui_state_extension

    install_xml_ui_state_extension()
    transaction = XmlChangeSetTransaction(repo_root, change_set_id)
    transaction.path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = transaction.path.with_suffix(".lock")
    lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        _lock(lock_fd)
        transaction._root = xml_state._load_document_or_new(
            transaction.path,
            transaction.change_set_id,
        )
        yield transaction
        xml_state._validate_document(transaction._root)
        xml_state._atomic_write(transaction.path, xml_state._serialize(transaction._root))
    finally:
        _unlock(lock_fd)
        os.close(lock_fd)


def atomic_save_run_state(repo_root: Path | str, state) -> Path:
    """Persist a RunState and its canonical projection under one document lock."""

    with change_set_transaction(repo_root, state.change_set_id) as transaction:
        transaction.save_run_state(state)
        return transaction.path


def _lock(file_descriptor: int) -> None:
    try:
        import fcntl
    except ImportError as exc:  # pragma: no cover - runtime is POSIX-only today
        raise RuntimeError("canonical XML transactions require POSIX file locking") from exc
    fcntl.flock(file_descriptor, fcntl.LOCK_EX)


def _unlock(file_descriptor: int) -> None:
    try:
        import fcntl
    except ImportError:  # pragma: no cover
        return
    fcntl.flock(file_descriptor, fcntl.LOCK_UN)
