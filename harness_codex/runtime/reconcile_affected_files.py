"""Deterministically reconcile affected-files manifests before execution."""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping, Sequence

from harness_codex.runtime.validate_scope_diff import (
    _affected_file_docs,
    _extract_path_patterns,
    _matches_pattern,
    _patterns_from_affected_files,
    _patterns_from_changeset,
    _repo_taxonomy_aliases,
)


@dataclass(frozen=True)
class AffectedFilesRepairResult:
    path: Path
    changed: bool
    modify: tuple[str, ...]
    create: tuple[str, ...]
    forbidden: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "path": str(self.path),
            "changed": self.changed,
            "modify": list(self.modify),
            "create": list(self.create),
            "forbidden": list(self.forbidden),
        }


def reconcile_affected_files(
    *,
    repo_root: Path,
    change_set_id: str,
    work_item_id: str,
    plan_path: Path,
    output_path: Path | None = None,
    metadata: Mapping[str, object] | None = None,
) -> AffectedFilesRepairResult:
    root = repo_root.resolve()
    relative_plan = plan_path if not plan_path.is_absolute() else plan_path.relative_to(root)
    plan = root / relative_plan
    if not plan.is_file():
        raise FileNotFoundError(f"active plan is required: {relative_plan}")

    effective_metadata = {
        "change_set_path": f"docs/changes/active/{change_set_id}.md",
        "active_plan_path": str(relative_plan),
        "active_work_item_id": work_item_id,
        "affected_work_items": [
            {
                "id": work_item_id,
                "executor_inputs": [
                    str(relative_plan),
                    f"docs/use-cases/{work_item_id}/affected-files.md",
                    f"docs/maintenance/{work_item_id}/affected-files.md",
                ],
            }
        ],
    }
    if metadata:
        effective_metadata.update(metadata)

    manifest = _first_manifest(root, work_item_id, effective_metadata)
    manifest.parent.mkdir(parents=True, exist_ok=True)
    before = manifest.read_text(encoding="utf-8") if manifest.exists() else ""

    change_set_path = root / str(effective_metadata["change_set_path"])
    changeset_allow = tuple(
        pattern for pattern in _patterns_from_changeset(change_set_path) if pattern.kind != "block"
    )
    changeset_block = tuple(
        pattern for pattern in _patterns_from_changeset(change_set_path) if pattern.kind == "block"
    )

    current_allow, current_block = _patterns_from_affected_files(manifest, root)
    candidates = set(_candidate_patterns_from_policy(current_allow))
    candidates.update(_candidate_patterns_from_plan(plan.read_text(encoding="utf-8")))

    modify: set[str] = set()
    create: set[str] = set()
    for candidate in candidates:
        if _should_ignore(candidate):
            continue
        for normalized in _expand_aliases(candidate):
            if _blocked(normalized, changeset_block):
                continue
            if not _allowed_by_changeset(normalized, changeset_allow):
                continue
            if _tracked_or_exists(root, normalized) or _has_glob(normalized):
                modify.add(normalized)
            else:
                create.add(normalized)

    forbidden = {
        pattern.pattern
        for pattern in current_block
        if not pattern.pattern.startswith(".harness/")
    }
    if not forbidden:
        forbidden.update(_default_forbidden_patterns())

    rendered = _render_manifest(
        work_item_id=work_item_id,
        modify=tuple(sorted(modify)),
        create=tuple(sorted(create - modify)),
        forbidden=tuple(sorted(forbidden)),
    )
    changed = rendered != before
    if changed:
        manifest.write_text(rendered, encoding="utf-8")

    result = AffectedFilesRepairResult(
        path=manifest.relative_to(root),
        changed=changed,
        modify=tuple(sorted(modify)),
        create=tuple(sorted(create - modify)),
        forbidden=tuple(sorted(forbidden)),
    )
    if output_path is not None:
        output = output_path if output_path.is_absolute() else root / output_path
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result.as_dict(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return result


def _first_manifest(
    repo_root: Path,
    work_item_id: str,
    metadata: Mapping[str, object],
) -> Path:
    for path in _affected_file_docs(repo_root, work_item_id, metadata):
        if path.exists() or "docs/use-cases" in str(path) or "docs/maintenance" in str(path):
            return path
    return repo_root / "docs/use-cases" / work_item_id / "affected-files.md"


def _candidate_patterns_from_policy(patterns: Iterable[object]) -> tuple[str, ...]:
    return tuple(str(pattern.pattern) for pattern in patterns)


def _candidate_patterns_from_plan(text: str) -> tuple[str, ...]:
    return tuple(
        pattern
        for pattern in _extract_path_patterns(text)
        if _looks_like_project_path(pattern)
    )


def _expand_aliases(pattern: str) -> tuple[str, ...]:
    return tuple(dict.fromkeys((pattern, *_repo_taxonomy_aliases(pattern))))


def _allowed_by_changeset(path: str, patterns: Sequence[object]) -> bool:
    return any(_matches_pattern(path, pattern.pattern) for pattern in patterns)


def _blocked(path: str, patterns: Sequence[object]) -> bool:
    return any(_matches_pattern(path, pattern.pattern) for pattern in patterns)


def _tracked_or_exists(repo_root: Path, path: str) -> bool:
    if (repo_root / path).exists():
        return True
    completed = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", path],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed.returncode == 0


def _looks_like_project_path(pattern: str) -> bool:
    if pattern.startswith((".harness/", "docs/plans/", "docs/changes/")):
        return False
    return "/" in pattern and not pattern.startswith(("http://", "https://"))


def _should_ignore(pattern: str) -> bool:
    if pattern.endswith((".txt", ".log", ".json")) and pattern.startswith(".harness/"):
        return True
    return pattern in {"-", "--"}


def _has_glob(pattern: str) -> bool:
    return any(char in pattern for char in "*?[]")


def _default_forbidden_patterns() -> tuple[str, ...]:
    return (
        "app/**",
        "platform/**",
        "auth/**",
        "purchase/**",
        "seat/**",
        "event/**",
        "dispatcher/**",
        "broker/**",
        "user/**",
        "**/application-secret.yml",
    )


def _render_manifest(
    *,
    work_item_id: str,
    modify: tuple[str, ...],
    create: tuple[str, ...],
    forbidden: tuple[str, ...],
) -> str:
    lines = [
        f"# {work_item_id} Affected Files",
        "",
        "## Modify",
        *(f"- `{path}`" for path in modify),
        "",
        "## Create",
        *(f"- `{path}`" for path in create),
        "",
        "## Delete",
        "",
        "## Forbidden",
        *(f"- `{path}`" for path in forbidden),
        "",
    ]
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", required=True)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    result = reconcile_affected_files(
        repo_root=Path(args.repo_root),
        change_set_id=args.change_set,
        work_item_id=args.work_item,
        plan_path=Path(args.plan),
        output_path=Path(args.output) if args.output else None,
    )
    print(json.dumps(result.as_dict(), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
