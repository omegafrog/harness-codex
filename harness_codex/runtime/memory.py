"""Deprecated compatibility facade for ChangeSet-first long-term memory.

The old `.harness/memory/index.yaml` and score-based promotion model are gone.
New callers should use :mod:`harness_codex.runtime.changeset_memory` directly.
This module only keeps internal imports from older runtime entry points working
while exposing the new reviewed `docs/memory` corpus.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.changeset_memory import (
    ChangeSetMemoryError,
    MemoryDocument,
    create_verified_memory_document,
    load_memory_documents,
    rebuild_memory_index,
    search_memory as _search_changeset_memory,
)


class MemoryError(ChangeSetMemoryError):
    """Compatibility error for retired legacy memory commands."""


@dataclass(frozen=True)
class MemoryIndexEntry:
    id: str
    type: str
    keywords: tuple[str, ...]
    path: Path
    status: str
    last_validated: str
    summary: str = ""


@dataclass(frozen=True)
class MemoryEntry:
    index: MemoryIndexEntry
    metadata: Mapping[str, Any]
    body: str

    @property
    def id(self) -> str:
        return self.index.id

    @property
    def type(self) -> str:
        return self.index.type

    @property
    def path(self) -> Path:
        return self.index.path

    @property
    def status(self) -> str:
        return self.index.status

    @property
    def decision_impact(self) -> str:
        return "Reviewed ChangeSet-first memory is historical reference only."


@dataclass(frozen=True)
class MemorySearchResult:
    entry: MemoryEntry
    score: float
    matched_terms: tuple[str, ...]


@dataclass(frozen=True)
class MemoryScore:
    total: int
    decision: str
    required_fields_missing: tuple[str, ...]
    active_ready: bool


def load_memory_index(repo_root: Path | str) -> tuple[MemoryIndexEntry, ...]:
    return tuple(_index_entry(document) for document in load_memory_documents(repo_root))


def load_memory_entries(repo_root: Path | str) -> tuple[MemoryEntry, ...]:
    return tuple(_entry(document) for document in load_memory_documents(repo_root))


def load_memory_entry(repo_root: Path | str, index_entry: MemoryIndexEntry | str) -> MemoryEntry:
    target_id = index_entry if isinstance(index_entry, str) else index_entry.id
    for entry in load_memory_entries(repo_root):
        if entry.id == target_id:
            return entry
    raise MemoryError(f"unknown ChangeSet-first memory entry: {target_id}")


def search_memory(
    repo_root: Path | str,
    query: str,
    *,
    include_inactive: bool = False,
) -> tuple[MemorySearchResult, ...]:
    """Return reviewed-memory search hits through the retired API shape.

    `include_inactive` is ignored because the new corpus has no candidate or
    active runtime state: only `status: verified` documents are retrievable.
    """

    del include_inactive
    try:
        hits = _search_changeset_memory(repo_root, query)
    except ChangeSetMemoryError as error:
        raise MemoryError(str(error)) from error
    return tuple(
        MemorySearchResult(
            entry=_entry(hit.document),
            score=hit.score,
            matched_terms=tuple(
                term
                for reason in hit.rank_reasons
                if reason.startswith("matched=")
                for term in reason.removeprefix("matched=").split(",")
                if term
            ),
        )
        for hit in hits
    )


def rebuild_index(repo_root: Path | str) -> Path:
    return rebuild_memory_index(repo_root)


def create_memory(*args: Any, **kwargs: Any) -> Path:
    return create_verified_memory_document(*args, **kwargs)


def score_memory_candidate(candidate: Mapping[str, Any]) -> MemoryScore:
    del candidate
    raise MemoryError(
        "legacy memory score promotion is removed; use verified ChangeSet evidence "
        "and evolution accept to record review-learning memory"
    )


def validate_memory_entry(entry: MemoryEntry) -> None:
    if entry.status != "verified":
        raise MemoryError(f"memory entry is not verified: {entry.id}")


def _index_entry(document: MemoryDocument) -> MemoryIndexEntry:
    return MemoryIndexEntry(
        id=document.memory_id,
        type=document.kind,
        keywords=document.tags,
        path=document.document_path,
        status=document.status,
        last_validated=document.created_at,
        summary=document.body.splitlines()[0] if document.body else "",
    )


def _entry(document: MemoryDocument) -> MemoryEntry:
    return MemoryEntry(
        index=_index_entry(document),
        metadata={
            "source_path": str(document.source_path),
            "change_set_id": document.change_set_id,
            "work_item_id": document.work_item_id,
            "repository_revision": document.repository_revision,
            "applies_to": document.applies_to,
            "tags": document.tags,
        },
        body=document.body,
    )
