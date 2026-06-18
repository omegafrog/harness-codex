from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

import yaml


MEMORY_ROOT = Path(".harness/memory")
MEMORY_INDEX = MEMORY_ROOT / "index.yaml"
ACTIVE_REQUIRED_FIELDS = (
    "decision_impact",
    "applies_to",
    "evidence",
)
MEMORY_STATUSES = ("candidate", "active", "stale", "deprecated", "rejected")
SCORE_FIELDS = (
    "recurrence_likelihood",
    "decision_impact",
    "rediscovery_cost",
    "stability",
    "evidence",
    "scope_clarity",
    "safety",
)


class MemoryError(ValueError):
    pass


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
        value = self.metadata.get("decision_impact", "")
        return str(value).strip()


@dataclass(frozen=True)
class MemorySearchResult:
    entry: MemoryEntry
    score: int
    matched_terms: tuple[str, ...]


@dataclass(frozen=True)
class MemoryScore:
    total: int
    decision: str
    required_fields_missing: tuple[str, ...]
    active_ready: bool


def load_memory_index(repo_root: Path | str) -> tuple[MemoryIndexEntry, ...]:
    root = Path(repo_root)
    index_path = root / MEMORY_INDEX
    if not index_path.exists():
        return ()
    document = yaml.safe_load(index_path.read_text(encoding="utf-8")) or {}
    patterns = document.get("patterns", [])
    if not isinstance(patterns, list):
        raise MemoryError("memory index patterns must be a list")
    return tuple(_index_entry(item, root) for item in patterns)


def load_memory_entries(repo_root: Path | str) -> tuple[MemoryEntry, ...]:
    root = Path(repo_root)
    return tuple(load_memory_entry(root, entry) for entry in load_memory_index(root))


def load_memory_entry(
    repo_root: Path | str,
    index_entry: MemoryIndexEntry | str,
) -> MemoryEntry:
    root = Path(repo_root)
    entry = (
        _entry_by_id(root, index_entry)
        if isinstance(index_entry, str)
        else index_entry
    )
    absolute_path = root / MEMORY_ROOT / entry.path
    if not absolute_path.exists():
        raise MemoryError(f"missing memory entry: {MEMORY_ROOT / entry.path}")
    metadata, body = _split_front_matter(absolute_path.read_text(encoding="utf-8"))
    _validate_entry_metadata(entry, metadata)
    return MemoryEntry(index=entry, metadata=metadata, body=body)


def search_memory(
    repo_root: Path | str,
    query: str,
    *,
    include_inactive: bool = False,
) -> tuple[MemorySearchResult, ...]:
    terms = _terms(query)
    if not terms:
        return ()
    results: list[MemorySearchResult] = []
    for entry in load_memory_entries(repo_root):
        if not include_inactive and entry.status != "active":
            continue
        haystack = " ".join(
            [
                entry.id,
                entry.type,
                " ".join(entry.index.keywords),
                entry.index.summary,
                entry.decision_impact,
                entry.body,
            ]
        ).lower()
        matched = tuple(term for term in terms if term in haystack)
        if matched:
            score = len(matched) + _keyword_bonus(entry.index.keywords, matched)
            results.append(MemorySearchResult(entry, score, matched))
    return tuple(sorted(results, key=lambda result: (-result.score, result.entry.id)))


def score_memory_candidate(candidate: Mapping[str, Any]) -> MemoryScore:
    total = 0
    for field in SCORE_FIELDS:
        value = _candidate_score(candidate, field)
        if not isinstance(value, int) or value < 0 or value > 2:
            raise MemoryError(f"{field} score must be an integer from 0 to 2")
        total += value

    decision = _score_decision(total)
    missing = tuple(
        field
        for field in ACTIVE_REQUIRED_FIELDS
        if not _has_meaningful_value(candidate.get(field))
    )
    active_ready = total >= 12 and not missing and candidate.get("status") == "active"
    return MemoryScore(
        total=total,
        decision=decision,
        required_fields_missing=missing,
        active_ready=active_ready,
    )


def validate_memory_entry(entry: MemoryEntry) -> None:
    _validate_entry_metadata(entry.index, entry.metadata)


def _index_entry(item: object, root: Path) -> MemoryIndexEntry:
    if not isinstance(item, dict):
        raise MemoryError("memory index entry must be a mapping")
    entry_id = _required_string(item, "id")
    entry_type = _required_string(item, "type")
    raw_path = _required_string(item, "path")
    status = _required_string(item, "status")
    if status not in MEMORY_STATUSES:
        raise MemoryError(f"invalid memory status for {entry_id}: {status}")
    keywords = item.get("keywords", [])
    if not isinstance(keywords, list) or not all(isinstance(k, str) for k in keywords):
        raise MemoryError(f"memory keywords must be strings for {entry_id}")
    path = Path(raw_path)
    if path.is_absolute() or ".." in path.parts:
        raise MemoryError(f"memory path must stay under {MEMORY_ROOT}: {raw_path}")
    last_validated = str(item.get("last_validated", "")).strip()
    if not last_validated:
        raise MemoryError(f"memory last_validated is required for {entry_id}")
    if not (root / MEMORY_ROOT / path).exists():
        raise MemoryError(f"memory index points to missing path: {path}")
    return MemoryIndexEntry(
        id=entry_id,
        type=entry_type,
        keywords=tuple(keywords),
        path=path,
        status=status,
        last_validated=last_validated,
        summary=str(item.get("summary", "")).strip(),
    )


def _entry_by_id(root: Path, entry_id: str) -> MemoryIndexEntry:
    for entry in load_memory_index(root):
        if entry.id == entry_id:
            return entry
    raise MemoryError(f"unknown memory entry: {entry_id}")


def _split_front_matter(text: str) -> tuple[Mapping[str, Any], str]:
    if not text.startswith("---\n"):
        return {}, text
    try:
        _start, raw_metadata, body = text.split("---\n", 2)
    except ValueError as exc:
        raise MemoryError("memory front matter is not closed") from exc
    metadata = yaml.safe_load(raw_metadata) or {}
    if not isinstance(metadata, dict):
        raise MemoryError("memory front matter must be a mapping")
    return metadata, body.lstrip()


def _validate_entry_metadata(
    index_entry: MemoryIndexEntry,
    metadata: Mapping[str, Any],
) -> None:
    if metadata:
        if str(metadata.get("id", "")).strip() != index_entry.id:
            raise MemoryError(f"memory id mismatch: {index_entry.id}")
        if str(metadata.get("type", "")).strip() != index_entry.type:
            raise MemoryError(f"memory type mismatch: {index_entry.id}")
        if str(metadata.get("status", "")).strip() != index_entry.status:
            raise MemoryError(f"memory status mismatch: {index_entry.id}")
    if index_entry.status == "active":
        missing = [
            field
            for field in ACTIVE_REQUIRED_FIELDS
            if not _has_meaningful_value(metadata.get(field))
        ]
        if missing:
            joined = ", ".join(missing)
            raise MemoryError(
                f"active memory {index_entry.id} missing required fields: {joined}"
            )


def _terms(query: str) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            part.lower()
            for part in re.findall(r"[A-Za-z0-9_.-]+", query)
            if len(part) > 1
        )
    )


def _keyword_bonus(keywords: tuple[str, ...], matched: tuple[str, ...]) -> int:
    keyword_text = " ".join(keywords).lower()
    return sum(1 for term in matched if term in keyword_text)


def _score_decision(total: int) -> str:
    if total <= 5:
        return "do_not_store"
    if total <= 8:
        return "keep_as_evidence_or_candidate"
    if total <= 11:
        return "long_term_memory_candidate"
    return "active_long_term_memory"


def _candidate_score(candidate: Mapping[str, Any], field: str) -> object:
    scores = candidate.get("scores", {})
    if isinstance(scores, dict) and field in scores:
        return scores[field]
    score_key = f"{field}_score"
    if score_key in candidate:
        return candidate[score_key]
    value = candidate.get(field, 0)
    return value if isinstance(value, int) else 0


def _has_meaningful_value(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, (list, tuple, set, dict)):
        return bool(value)
    return True


def _required_string(item: Mapping[str, Any], key: str) -> str:
    value = item.get(key)
    if not isinstance(value, str) or not value.strip():
        raise MemoryError(f"memory index field is required: {key}")
    return value.strip()
