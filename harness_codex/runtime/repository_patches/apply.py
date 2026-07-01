"""Apply repo-local migration patches after harness update."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


PATCH_DIR = Path(__file__).with_name("patches")
STATE_DIR = Path(".harness/state/repository-patches")
PATH_TOKEN_RE = re.compile(r"`([^`]+)`|(?<![\w.-])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.*{}<>, -]+)*)")


@dataclass(frozen=True)
class RepositoryPatchResult:
    patch_id: str
    patch_path: str
    changed_files: tuple[str, ...]
    removed_lines: int
    skipped: bool
    moved_paths: tuple[str, ...] = ()
    conflicts: tuple[str, ...] = ()


def apply_repository_patches(repo_root: Path) -> tuple[RepositoryPatchResult, ...]:
    root = repo_root.resolve()
    results: list[RepositoryPatchResult] = []
    for patch_path in sorted(PATCH_DIR.glob("*.patch")):
        results.append(_apply_patch_file(root, patch_path))
    return tuple(results)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    args = parser.parse_args(argv)
    results = apply_repository_patches(Path(args.repo_root))
    payload = {
        "status": "passed",
        "patches": [
            {
                "patch_id": result.patch_id,
                "patch_path": result.patch_path,
                "changed_files": list(result.changed_files),
                "removed_lines": result.removed_lines,
                "moved_paths": list(result.moved_paths),
                "conflicts": list(result.conflicts),
                "skipped": result.skipped,
            }
            for result in results
        ],
    }
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0


def _apply_patch_file(repo_root: Path, patch_path: Path) -> RepositoryPatchResult:
    content = patch_path.read_text(encoding="utf-8")
    patch_id = _patch_id(patch_path, content)
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    state_path = repo_root / STATE_DIR / f"{patch_id}.json"
    remove_patterns = _remove_patterns(content)
    move_pairs = _move_pairs(content)
    changed_files: list[str] = []
    moved_paths: list[str] = []
    conflicts: list[str] = []
    removed_lines = 0

    for manifest in _affected_file_manifests(repo_root):
        original = manifest.read_text(encoding="utf-8")
        updated, removed = _remove_matching_lines(original, remove_patterns)
        if removed == 0 or updated == original:
            continue
        manifest.write_text(updated, encoding="utf-8")
        changed_files.append(str(manifest.relative_to(repo_root)))
        removed_lines += removed

    for source, target in move_pairs:
        outcome = _move_path(repo_root / source, repo_root / target)
        if outcome == "moved":
            moved_paths.append(f"{source} -> {target}")
        elif outcome == "conflict":
            conflicts.append(f"{source} -> {target}")

    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(
        json.dumps(
            {
                "patch_id": patch_id,
                "patch_sha256": digest,
                "changed_files": changed_files,
                "removed_lines": removed_lines,
                "moved_paths": moved_paths,
                "conflicts": conflicts,
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return RepositoryPatchResult(
        patch_id=patch_id,
        patch_path=str(patch_path.relative_to(PATCH_DIR.parent.parent.parent.parent)),
        changed_files=tuple(changed_files),
        removed_lines=removed_lines,
        moved_paths=tuple(moved_paths),
        conflicts=tuple(conflicts),
        skipped=removed_lines == 0 and not moved_paths and not conflicts,
    )


def _patch_id(path: Path, content: str) -> str:
    for line in content.splitlines():
        if line.startswith("# id:"):
            value = line.split(":", 1)[1].strip()
            if value:
                return value
    return path.stem


def _remove_patterns(content: str) -> tuple[str, ...]:
    patterns: list[str] = []
    in_section = False
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line == "[affected-files-remove]":
            in_section = True
            continue
        if line.startswith("[") and line.endswith("]"):
            in_section = False
            continue
        if in_section:
            patterns.append(line)
    return tuple(dict.fromkeys(patterns))


def _move_pairs(content: str) -> tuple[tuple[str, str], ...]:
    pairs: list[tuple[str, str]] = []
    in_section = False
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line == "[move]":
            in_section = True
            continue
        if line.startswith("[") and line.endswith("]"):
            in_section = False
            continue
        if in_section and "=>" in line:
            source, target = (part.strip() for part in line.split("=>", 1))
            if source and target:
                pairs.append((source, target))
    return tuple(dict.fromkeys(pairs))


def _move_path(source: Path, target: Path) -> str:
    if not source.exists():
        return "skipped"
    if target.exists():
        if source.is_file() and target.is_file() and _same_file_content(source, target):
            source.unlink()
            _prune_empty_parents(source.parent)
            return "moved"
        return "conflict"
    target.parent.mkdir(parents=True, exist_ok=True)
    source.rename(target)
    _prune_empty_parents(source.parent)
    return "moved"


def _same_file_content(left: Path, right: Path) -> bool:
    try:
        return left.read_bytes() == right.read_bytes()
    except OSError:
        return False


def _prune_empty_parents(path: Path) -> None:
    stop_parts = {"docs", ".harness"}
    current = path
    while current.name not in stop_parts and current.exists():
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent


def _affected_file_manifests(repo_root: Path) -> tuple[Path, ...]:
    manifests = [
        *repo_root.glob("docs/use-cases/*/affected-files.md"),
        *repo_root.glob("docs/maintenance/*/affected-files.md"),
    ]
    return tuple(sorted(path for path in manifests if path.is_file()))


def _remove_matching_lines(content: str, patterns: Sequence[str]) -> tuple[str, int]:
    kept: list[str] = []
    removed = 0
    for line in content.splitlines():
        tokens = _path_tokens(line)
        if tokens and any(_matches_any(token, patterns) for token in tokens):
            removed += 1
            continue
        kept.append(line)
    suffix = "\n" if content.endswith("\n") else ""
    return "\n".join(kept) + suffix, removed


def _path_tokens(line: str) -> tuple[str, ...]:
    tokens: list[str] = []
    for match in PATH_TOKEN_RE.finditer(line):
        value = match.group(1) or match.group(2) or ""
        normalized = value.strip().strip("|,;:)").removeprefix("./")
        if normalized:
            tokens.append(normalized)
    return tuple(dict.fromkeys(tokens))


def _matches_any(path: str, patterns: Sequence[str]) -> bool:
    return any(_matches(path, pattern) for pattern in patterns)


def _matches(path: str, pattern: str) -> bool:
    if pattern.endswith("/**"):
        return path == pattern[:-3] or path.startswith(pattern[:-2])
    if pattern.startswith("**/"):
        suffix = pattern[3:]
        return path == suffix or path.endswith("/" + suffix)
    if any(char in pattern for char in "*?[]"):
        return fnmatch.fnmatch(path, pattern)
    return path == pattern


if __name__ == "__main__":
    raise SystemExit(main())
