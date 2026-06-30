"""Run-local file snapshot cache for repeated agent reads."""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CACHE_ROOT = Path(".harness/memory-cache/files")
INDEX_NAME = "index.json"
DEFAULT_MAX_BYTES = 1024 * 1024


class FileMemoryCacheError(ValueError):
    """Raised when a file cannot be cached safely."""


@dataclass(frozen=True)
class FileCacheRead:
    path: str
    content: str
    cache_hit: bool
    sha256: str
    size: int
    cache_file: Path


@dataclass(frozen=True)
class FileCacheWarmResult:
    warmed: int
    hits: int
    refreshed: int
    skipped: tuple[str, ...]


def read_file_cache(
    repo_root: Path,
    path: str | Path,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> FileCacheRead:
    root = repo_root.resolve()
    relative = _repo_relative_path(root, path)
    absolute = root / relative
    if not absolute.is_file():
        raise FileMemoryCacheError(f"cache target is not a file: {relative}")
    stat = absolute.stat()
    if stat.st_size > max_bytes:
        raise FileMemoryCacheError(f"cache target exceeds max bytes: {relative}")

    index = _load_index(root)
    indexed = index.get(relative)
    if isinstance(indexed, dict) and _metadata_matches(indexed, stat):
        cache_file = root / CACHE_ROOT / str(indexed.get("cache_file", ""))
        cached = _load_cache_file(cache_file)
        if cached.get("path") == relative and cached.get("content_sha256") == indexed.get("sha256"):
            content = str(cached.get("content", ""))
            return FileCacheRead(
                path=relative,
                content=content,
                cache_hit=True,
                sha256=str(indexed["sha256"]),
                size=int(indexed["size"]),
                cache_file=cache_file.relative_to(root),
            )

    raw = absolute.read_bytes()
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError as error:
        raise FileMemoryCacheError(f"cache target is not utf-8 text: {relative}") from error
    sha256 = hashlib.sha256(raw).hexdigest()
    cache_name = f"{hashlib.sha256(f'{relative}\\0{sha256}'.encode('utf-8')).hexdigest()}.json"
    cache_path = root / CACHE_ROOT / cache_name
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps(
            {
                "path": relative,
                "content_sha256": sha256,
                "size": stat.st_size,
                "mtime_ns": stat.st_mtime_ns,
                "cached_at": datetime.now(timezone.utc).isoformat(),
                "content": content,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    index[relative] = {
        "path": relative,
        "sha256": sha256,
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
        "cache_file": cache_name,
    }
    _write_index(root, index)
    return FileCacheRead(
        path=relative,
        content=content,
        cache_hit=False,
        sha256=sha256,
        size=stat.st_size,
        cache_file=cache_path.relative_to(root),
    )


def warm_file_cache(
    repo_root: Path,
    paths: list[str | Path],
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> FileCacheWarmResult:
    hits = 0
    refreshed = 0
    skipped: list[str] = []
    for path in paths:
        try:
            result = read_file_cache(repo_root, path, max_bytes=max_bytes)
        except FileMemoryCacheError as error:
            skipped.append(str(error))
            continue
        if result.cache_hit:
            hits += 1
        else:
            refreshed += 1
    return FileCacheWarmResult(
        warmed=hits + refreshed,
        hits=hits,
        refreshed=refreshed,
        skipped=tuple(skipped),
    )


def file_cache_stats(repo_root: Path) -> dict[str, int]:
    root = repo_root.resolve()
    index = _load_index(root)
    cache_dir = root / CACHE_ROOT
    cache_files = (
        tuple(path for path in cache_dir.glob("*.json") if path.name != INDEX_NAME)
        if cache_dir.exists()
        else ()
    )
    total_bytes = sum(path.stat().st_size for path in cache_files if path.is_file())
    return {
        "indexed_files": len(index),
        "cache_files": len(cache_files),
        "cache_bytes": total_bytes,
    }


def clear_file_cache(repo_root: Path) -> int:
    root = repo_root.resolve()
    cache_dir = root / CACHE_ROOT
    if not cache_dir.exists():
        return 0
    removed = 0
    for path in cache_dir.glob("*.json"):
        path.unlink()
        removed += 1
    index_path = cache_dir / INDEX_NAME
    if index_path.exists():
        index_path.unlink()
    return removed


def _repo_relative_path(repo_root: Path, path: str | Path) -> str:
    candidate = Path(path)
    if candidate.is_absolute():
        try:
            candidate = candidate.resolve().relative_to(repo_root)
        except ValueError as error:
            raise FileMemoryCacheError(f"cache target is outside repo: {path}") from error
    normalized = Path(candidate)
    if any(part == ".." for part in normalized.parts):
        raise FileMemoryCacheError(f"cache target must stay inside repo: {path}")
    if not normalized.parts:
        raise FileMemoryCacheError("cache target path is empty")
    return normalized.as_posix()


def _load_index(repo_root: Path) -> dict[str, dict[str, Any]]:
    index_path = repo_root / CACHE_ROOT / INDEX_NAME
    if not index_path.exists():
        return {}
    data = json.loads(index_path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise FileMemoryCacheError("file memory cache index must be a mapping")
    return {str(key): value for key, value in data.items() if isinstance(value, dict)}


def _write_index(repo_root: Path, index: dict[str, dict[str, Any]]) -> None:
    index_path = repo_root / CACHE_ROOT / INDEX_NAME
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(
        json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def _metadata_matches(indexed: dict[str, Any], stat: Any) -> bool:
    return indexed.get("size") == stat.st_size and indexed.get("mtime_ns") == stat.st_mtime_ns


def _load_cache_file(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}
