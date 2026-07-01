"""Apply repo-local migration patches after harness update."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


PATCH_DIR = Path(__file__).with_name("patches")
STATE_DIR = Path(".harness/state/repository-patches")


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
    move_pairs = _move_pairs(content)
    changed_files: list[str] = []
    moved_paths: list[str] = []
    conflicts: list[str] = []
    removed_lines = 0

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


if __name__ == "__main__":
    raise SystemExit(main())
