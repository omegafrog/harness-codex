"""Validate executor worktree changes against ChangeSet scope.

The active implementation plan is an instruction and execution-state artifact. It is
never an authority source for implementation writes. Code/test writes must be
permitted by the ChangeSet included scope. Legacy ``affected-files.md`` documents
are not implementation authority.
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence

from harness_codex.runtime.artifact_boundary import (
    control_plane_block_patterns,
    is_evolve_context,
    project_output_allow_patterns,
    runtime_output_allow_patterns,
)
from harness_codex.runtime.changes.parser import parse_changeset_markdown


PATH_CODE_RE = re.compile(r"`([^`]+)`")
PATH_TOKEN_RE = re.compile(r"(?<![\w.-])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.*{}<>, -]+)+)")
_MANIFEST_LINE_RE = re.compile(
    r"^\s*(?:[-*+]\s+)?(?P<operation>modify|create|delete|forbidden|"
    r"수정|생성|삭제|금지)\s*:\s*(?P<value>.+?)\s*$",
    flags=re.IGNORECASE,
)

_ALL_OPERATIONS = ("modify", "create", "delete")
_OPERATION_ALIASES = {
    "modify": ("modify",),
    "수정": ("modify",),
    "create": ("create",),
    "생성": ("create",),
    "delete": ("delete",),
    "삭제": ("delete",),
    "forbidden": _ALL_OPERATIONS,
    "금지": _ALL_OPERATIONS,
}


@dataclass(frozen=True)
class ScopePattern:
    pattern: str
    source: str
    kind: str = "allow"
    operations: tuple[str, ...] = _ALL_OPERATIONS


@dataclass(frozen=True)
class ScopePolicy:
    """Authority inputs used by the executor scope boundary."""

    runtime_allow: tuple[ScopePattern, ...]
    changeset_allow: tuple[ScopePattern, ...]
    manifest_allow: tuple[ScopePattern, ...]
    blocked: tuple[ScopePattern, ...]


@dataclass(frozen=True)
class ScopeDiffResult:
    status: str
    report_path: Path
    blocked_files: tuple[str, ...]
    message: str | None = None


def capture_git_snapshot(repo_root: Path) -> dict[str, dict[str, str | None]]:
    """Record modified worktree paths in a comparison-friendly snapshot."""

    if not _inside_git_work_tree(repo_root):
        return {}

    snapshot: dict[str, dict[str, str | None]] = {}
    for path in sorted(_git_changed_paths(repo_root)):
        absolute = repo_root / path
        snapshot[path] = {
            "path": path,
            "state": _file_state(absolute),
            "sha256": _sha256(absolute),
        }
    return snapshot


def write_snapshot(path: Path, snapshot: Mapping[str, Mapping[str, str | None]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def validate_scope_diff(
    *,
    repo_root: Path,
    run_id: str,
    change_set_id: str,
    work_item_id: str,
    before: Mapping[str, Mapping[str, str | None]],
    after: Mapping[str, Mapping[str, str | None]],
    report_path: Path,
    context_metadata: Mapping[str, Any] | None = None,
    runtime_allow_patterns: Sequence[ScopePattern] = (),
) -> ScopeDiffResult:
    """Write a scope report and block implementation changes outside authority.

    Runtime artifacts and executor-owned active-plan state are treated as a separate
    ownership boundary. All other files require ChangeSet included scope matches
    for the actual operation (modify/create/delete).
    """

    metadata = context_metadata or {}
    policy = _scope_policy(
        repo_root=repo_root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        metadata=metadata,
        runtime_allow_patterns=runtime_allow_patterns,
    )
    changed_files = _changed_between(before, after)

    allowed: list[dict[str, Any]] = []
    suspicious: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    changed_rows: list[dict[str, Any]] = []

    for path in changed_files:
        operation = _change_operation(
            repo_root,
            path,
            before.get(path),
            after.get(path),
        )
        runtime_matches = _matching_sources(path, policy.runtime_allow, operation)
        changeset_matches = _matching_sources(path, policy.changeset_allow, operation)
        manifest_matches = _matching_sources(path, policy.manifest_allow, operation)
        block_matches = _matching_sources(path, policy.blocked, operation)
        implementation_allowed = bool(changeset_matches)
        allowed_sources = runtime_matches or list(dict.fromkeys(changeset_matches))
        row = {
            "path": path,
            "operation": operation,
            "before": before.get(path),
            "after": after.get(path),
            "allowed_sources": allowed_sources,
            "change_set_sources": changeset_matches,
            "manifest_sources": manifest_matches,
            "runtime_sources": runtime_matches,
            "blocked_sources": block_matches,
        }
        changed_rows.append(row)
        if (block_matches and not runtime_matches) or not allowed_sources:
            blocked.append(row)
        elif _is_suspicious_path(path, allowed_sources):
            suspicious.append(row)
        else:
            allowed.append(row)

    status = "blocked" if blocked else "passed"
    source_summary = _policy_source_summary(policy)
    report = {
        "status": status,
        "run_id": run_id,
        "change_set_id": change_set_id,
        "work_item_id": work_item_id,
            "authority_model": {
            "implementation_write_allowlist": "ChangeSet included scope",
            "plan_paths_grant_implementation_authority": False,
            "control_plane_writes_allowed": is_evolve_context(metadata),
        },
        "changed_files": changed_rows,
        "plan_task_file_map": _plan_task_file_map(
            repo_root=repo_root,
            work_item_id=work_item_id,
            metadata=metadata,
            changed_rows=changed_rows,
        ),
        "allowed": allowed,
        "suspicious": suspicious,
        "blocked": blocked,
        "allowed_scope_sources": source_summary,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    blocked_files = tuple(row["path"] for row in blocked)
    message = None
    if blocked_files:
        message = (
            "scope diff blocked unexpected files: "
            + ", ".join(blocked_files)
            + ". implementation files require ChangeSet included scope permission. "
            "allowed scope sources: "
            + ", ".join(source_summary)
        )
    return ScopeDiffResult(
        status=status,
        report_path=report_path,
        blocked_files=blocked_files,
        message=message,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", required=True)
    parser.add_argument("--before", required=True)
    parser.add_argument("--after", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args(argv)

    repo_root = Path(args.repo_root).resolve()
    before = json.loads(Path(args.before).read_text(encoding="utf-8"))
    after = json.loads(Path(args.after).read_text(encoding="utf-8"))
    result = validate_scope_diff(
        repo_root=repo_root,
        run_id="manual",
        change_set_id=args.change_set,
        work_item_id=args.work_item,
        before=before,
        after=after,
        report_path=Path(args.report),
        context_metadata={
            "change_set_path": f"docs/changes/active/{args.change_set}.md",
            "active_work_item_id": args.work_item,
            "active_plan_path": f"docs/plans/active/{args.work_item}/plan.md",
        },
    )
    print(result.message or f"scope diff {result.status}: {result.report_path}")
    return 1 if result.blocked_files else 0


def _inside_git_work_tree(repo_root: Path) -> bool:
    completed = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed.returncode == 0 and completed.stdout.strip() == "true"


def _git_changed_paths(repo_root: Path) -> set[str]:
    paths: set[str] = set()
    commands = (
        ["git", "diff", "--name-only"],
        ["git", "diff", "--name-only", "--cached"],
        ["git", "ls-files", "--others", "--exclude-standard"],
    )
    for command in commands:
        completed = subprocess.run(
            command,
            cwd=repo_root,
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            continue
        for line in completed.stdout.splitlines():
            normalized = _normalize_path_token(line)
            if not normalized:
                continue
            absolute = repo_root / normalized
            if absolute.is_dir():
                paths.update(
                    str(path.relative_to(repo_root))
                    for path in absolute.rglob("*")
                    if path.is_file()
                )
            else:
                paths.add(normalized)
    return paths


def _file_state(path: Path) -> str:
    if path.is_file():
        return "file"
    if path.is_dir():
        return "directory"
    return "missing"


def _sha256(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _changed_between(
    before: Mapping[str, Mapping[str, str | None]],
    after: Mapping[str, Mapping[str, str | None]],
) -> tuple[str, ...]:
    paths = set(before) | set(after)
    return tuple(sorted(path for path in paths if before.get(path) != after.get(path)))


def _plan_task_file_map(
    *,
    repo_root: Path,
    work_item_id: str,
    metadata: Mapping[str, Any],
    changed_rows: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    plan_path = _active_plan_path(repo_root, work_item_id, metadata)
    if plan_path is None or not plan_path.exists():
        return []
    tasks = _parse_plan_tasks(plan_path.read_text(encoding="utf-8"))
    if not tasks:
        return []
    rows = [row for row in changed_rows if isinstance(row.get("path"), str)]
    mapped = []
    for task in tasks:
        tokens = _task_file_tokens(task["text"])
        files = []
        for row in rows:
            path = str(row["path"])
            if _task_matches_path(tokens, path):
                operation = str(row.get("operation") or "modify")
                files.append(
                    {
                        "path": path,
                        "status": _diff_status_from_operation(operation),
                        "operation": operation,
                    }
                )
        mapped.append(
            {
                "work_item_id": work_item_id,
                "line": task["line"],
                "checked": task["checked"],
                "text": task["text"],
                "files": files,
                "match": "plan-task-token",
            }
        )
    return mapped


def _active_plan_path(
    repo_root: Path,
    work_item_id: str,
    metadata: Mapping[str, Any],
) -> Path | None:
    raw_path = metadata.get("active_plan_path")
    if isinstance(raw_path, str) and raw_path:
        return repo_root / raw_path
    fallback = repo_root / "docs" / "plans" / "active" / work_item_id / "plan.md"
    if fallback.exists():
        return fallback
    completed = repo_root / "docs" / "plans" / "completed" / work_item_id / "plan.md"
    return completed if completed.exists() else None


def _parse_plan_tasks(content: str) -> list[dict[str, Any]]:
    tasks: list[dict[str, Any]] = []
    for line_number, line in enumerate(content.splitlines(), start=1):
        match = re.match(r"^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$", line)
        if match:
            tasks.append(
                {
                    "line": line_number,
                    "checked": match.group(1).lower() == "x",
                    "text": match.group(2).strip(),
                }
            )
    return tasks


def _task_file_tokens(text: str) -> tuple[str, ...]:
    tokens: set[str] = set()
    raw = str(text or "")
    for match in re.finditer(r"`([^`]+)`", raw):
        for part in re.split(r"[^A-Za-z0-9_.$/-]+", match.group(1)):
            _add_task_token(tokens, part)
    for match in re.finditer(r"\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b", raw):
        _add_task_token(tokens, match.group(0))
    for match in re.finditer(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+", raw):
        _add_task_token(tokens, match.group(0))
    return tuple(sorted(tokens))


def _add_task_token(tokens: set[str], value: str) -> None:
    token = str(value or "").strip().lower()
    if len(token) < 4:
        return
    if re.fullmatch(r"(http|https|api|user|true|false|null|count|list|page|size|sort)", token):
        return
    tokens.add(token)
    if "." in token:
        tokens.add(token.split(".", 1)[0])


def _task_matches_path(tokens: Sequence[str], path: str) -> bool:
    normalized = path.lower()
    name = normalized.rsplit("/", 1)[-1]
    return any(token in normalized or token in name for token in tokens)


def _diff_status_from_operation(operation: str) -> str:
    if operation == "create":
        return "A"
    if operation == "delete":
        return "D"
    return "M"


def _scope_policy(
    *,
    repo_root: Path,
    change_set_id: str,
    work_item_id: str,
    metadata: Mapping[str, Any],
    runtime_allow_patterns: Sequence[ScopePattern],
) -> ScopePolicy:
    runtime_allow = [
        *_runtime_generated_output_patterns(),
        *runtime_allow_patterns,
    ]
    active_plan_path = _metadata_path(metadata, "active_plan_path")
    if active_plan_path:
        runtime_allow.append(
            ScopePattern(str(active_plan_path), "executor-owned active plan state")
        )

    changeset_allow: list[ScopePattern] = []
    blocked: list[ScopePattern] = []
    change_set_path = _metadata_path(metadata, "change_set_path") or Path(
        f"docs/changes/active/{change_set_id}.md"
    )
    for pattern in _patterns_from_changeset(repo_root / change_set_path):
        if pattern.kind == "block":
            blocked.append(pattern)
        else:
            changeset_allow.append(pattern)

    manifest_allow: list[ScopePattern] = []

    if not is_evolve_context(metadata):
        blocked.extend(
            ScopePattern(pattern, "non-evolve control-plane/read-only boundary", "block")
            for pattern in control_plane_block_patterns()
        )

    return ScopePolicy(
        runtime_allow=tuple(_dedupe_patterns(runtime_allow)),
        changeset_allow=tuple(_dedupe_patterns(changeset_allow)),
        manifest_allow=tuple(_dedupe_patterns(manifest_allow)),
        blocked=tuple(_dedupe_patterns(blocked)),
    )


def _runtime_generated_output_patterns() -> tuple[ScopePattern, ...]:
    """Allow generated local verification outputs without granting source writes."""

    return (
        *(
            ScopePattern(pattern, source)
            for pattern, source in runtime_output_allow_patterns()
        ),
        *(
            ScopePattern(pattern, source)
            for pattern, source in project_output_allow_patterns()
        ),
    )


def _patterns_from_changeset(path: Path) -> tuple[ScopePattern, ...]:
    if not path.is_file():
        return ()
    text = path.read_text(encoding="utf-8")
    change_set = parse_changeset_markdown(text, path=_relative_path(path))
    patterns: list[ScopePattern] = []
    for item in change_set.included_scope:
        patterns.extend(
            ScopePattern(pattern, "ChangeSet included scope")
            for pattern in _extract_path_patterns(item)
        )
    for item in change_set.forbidden_changes + change_set.excluded_scope:
        patterns.extend(
            ScopePattern(
                pattern,
                "ChangeSet excluded/forbidden scope",
                "block",
            )
            for pattern in _extract_path_patterns(item)
        )
    return tuple(patterns)


def _patterns_from_affected_files(
    path: Path,
    repo_root: Path,
) -> tuple[tuple[ScopePattern, ...], tuple[ScopePattern, ...]]:
    if not path.is_file():
        return (), ()
    text = path.read_text(encoding="utf-8")
    source_path = _manifest_source_path(path, repo_root)
    allow: list[ScopePattern] = []
    block: list[ScopePattern] = []
    recognized: set[tuple[str, str]] = set()

    for title, content in _markdown_sections(text).items():
        operation = _manifest_operation(title)
        if operation is None and _block_section_title(title):
            operation = "forbidden"
        if operation is None:
            continue
        for pattern in _extract_path_patterns(content):
            key = (operation, pattern)
            recognized.add(key)
            target = block if operation == "forbidden" else allow
            target.append(
                ScopePattern(
                    pattern,
                    f"affected-files {operation} {source_path}",
                    "block" if operation == "forbidden" else "allow",
                    _operations_for_manifest_pattern(operation, pattern),
                )
            )
            for alias in _repo_taxonomy_aliases(pattern):
                target.append(
                    ScopePattern(
                        alias,
                        f"affected-files {operation} taxonomy alias {source_path}",
                        "block" if operation == "forbidden" else "allow",
                        _operations_for_manifest_pattern(operation, alias),
                    )
                )

    for line in text.splitlines():
        match = _MANIFEST_LINE_RE.match(line)
        if not match:
            continue
        canonical = _canonical_manifest_operation(match.group("operation"))
        if canonical is None:
            continue
        for pattern in _extract_path_patterns(match.group("value")):
            key = (canonical, pattern)
            if key in recognized:
                continue
            target = block if canonical == "forbidden" else allow
            target.append(
                ScopePattern(
                    pattern,
                    f"affected-files {canonical} {source_path}",
                    "block" if canonical == "forbidden" else "allow",
                    _operations_for_manifest_pattern(canonical, pattern),
                )
            )
            for alias in _repo_taxonomy_aliases(pattern):
                target.append(
                    ScopePattern(
                        alias,
                        f"affected-files {canonical} taxonomy alias {source_path}",
                        "block" if canonical == "forbidden" else "allow",
                        _operations_for_manifest_pattern(canonical, alias),
                    )
                )

    # Legacy, non-operation headings such as "Expected Files" and "Test Targets"
    # describe the intended work-item file set, so they authorize create and modify.
    # Deletions still require an explicit delete declaration.
    for title, content in _markdown_sections(text).items():
        if _manifest_operation(title) is not None or _block_section_title(title):
            continue
        for pattern in _extract_path_patterns(content):
            if ("modify", pattern) in recognized or ("create", pattern) in recognized:
                continue
            allow.append(
                ScopePattern(
                    pattern,
                    f"affected-files expected/create-modify {source_path}",
                    operations=("create", "modify"),
                )
            )
            for alias in _repo_taxonomy_aliases(pattern):
                allow.append(
                    ScopePattern(
                        alias,
                        f"affected-files expected/create-modify taxonomy alias {source_path}",
                        operations=("create", "modify"),
                    )
                )

    return tuple(_dedupe_patterns(allow)), tuple(_dedupe_patterns(block))


def _repo_taxonomy_aliases(pattern: str) -> tuple[str, ...]:
    """Map stale Spring-convention layer paths to existing harness taxonomy.

    Older affected-files documents may contain `controller`, `service`, or
    `infrastructure` segments even when the repository uses
    `ui/application/domain/infra`. Scope authority remains manifest based; this
    only expands equivalent layer names so a stale generated manifest does not
    block the repo's actual package taxonomy.
    """

    aliases: list[str] = []
    replacements = (
        ("/controller/", "/ui/"),
        ("/infrastructure/", "/infra/"),
        ("/application/service/", "/application/"),
        ("/domain/service/", "/domain/"),
    )
    for old, new in replacements:
        if old in pattern:
            aliases.append(pattern.replace(old, new))
    if "/controller/" in pattern and pattern.endswith("Dto.java"):
        aliases.append(pattern.replace("/controller/", "/ui/dto/"))
    return tuple(dict.fromkeys(alias for alias in aliases if alias != pattern))


def _affected_file_docs(
    repo_root: Path,
    work_item_id: str,
    metadata: Mapping[str, Any],
) -> tuple[Path, ...]:
    candidates: list[Path] = []
    for item in metadata.get("affected_work_items", ()):
        if not isinstance(item, Mapping) or item.get("id") != work_item_id:
            continue
        for raw in item.get("executor_inputs", ()):
            path = Path(str(raw))
            if path.name == "affected-files.md":
                candidates.append(repo_root / path)
    candidates.extend(
        (
            repo_root / f"docs/use-cases/{work_item_id}/affected-files.md",
            repo_root / f"docs/maintenance/{work_item_id}/affected-files.md",
        )
    )
    return tuple(dict.fromkeys(candidates))


def _change_operation(
    repo_root: Path,
    path: str,
    before: Mapping[str, str | None] | None,
    after: Mapping[str, str | None] | None,
) -> str:
    before_exists = _snapshot_exists(before)
    after_exists = _snapshot_exists(after)
    if not before_exists and after_exists:
        if _git_tracks_path(repo_root, path):
            return "modify"
        return "create"
    if before_exists and not after_exists:
        return "delete"
    return "modify"


def _git_tracks_path(repo_root: Path, path: str) -> bool:
    completed = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "--", path],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed.returncode == 0


def _snapshot_exists(snapshot: Mapping[str, str | None] | None) -> bool:
    return bool(snapshot) and snapshot.get("state") not in {None, "missing"}


def _matching_sources(
    path: str,
    patterns: Iterable[ScopePattern],
    operation: str,
) -> list[str]:
    return [
        pattern.source
        for pattern in patterns
        if operation in pattern.operations and _matches_pattern(path, pattern.pattern)
    ]


def _matches_pattern(path: str, pattern: str) -> bool:
    if pattern.endswith("/"):
        return path.startswith(pattern)
    if any(char in pattern for char in "*?[]"):
        return fnmatch.fnmatch(path, pattern)
    return path == pattern


def _intersection_sources(
    changeset_sources: Sequence[str],
    manifest_sources: Sequence[str],
) -> list[str]:
    return [
        *[f"{source} (intersection)" for source in dict.fromkeys(changeset_sources)],
        *[f"{source} (intersection)" for source in dict.fromkeys(manifest_sources)],
    ]


def _policy_source_summary(policy: ScopePolicy) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            [
                *(pattern.source for pattern in policy.runtime_allow),
                *(pattern.source for pattern in policy.changeset_allow),
                *(pattern.source for pattern in policy.manifest_allow),
            ]
        )
    )


def _is_suspicious_path(path: str, sources: Sequence[str]) -> bool:
    config_names = {
        "build.gradle",
        "build.gradle.kts",
        "settings.gradle",
        "settings.gradle.kts",
        "pom.xml",
        "pyproject.toml",
        "package.json",
        "package-lock.json",
    }
    return Path(path).name in config_names and not any(
        "ChangeSet included scope" in source or "affected-files" in source
        for source in sources
    )


def _extract_path_patterns(text: str) -> tuple[str, ...]:
    values: list[str] = []
    values.extend(match.group(1) for match in PATH_CODE_RE.finditer(text))
    values.extend(match.group(1) for match in PATH_TOKEN_RE.finditer(text))
    return tuple(
        dict.fromkeys(
            normalized
            for value in values
            if (normalized := _normalize_path_token(value))
        )
    )


def _normalize_path_token(value: str) -> str:
    token = value.strip().strip("|,;:)")
    token = token.removeprefix("./")
    if not token or "://" in token:
        return ""
    if "<" in token or ">" in token or "..." in token:
        return ""
    if token.startswith("/"):
        return ""
    return token


def _markdown_sections(text: str) -> dict[str, str]:
    matches = list(re.finditer(r"^#{1,3}\s+(.+?)\s*$", text, flags=re.MULTILINE))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[match.group(1).strip()] = text[start:end]
    if not sections:
        sections[""] = text
    return sections


def _manifest_operation(title: str) -> str | None:
    normalized = title.strip().lower().strip("# :")
    normalized = re.sub(r"\s+", " ", normalized)
    aliases = {
        "modify": "modify",
        "modifications": "modify",
        "수정": "modify",
        "create": "create",
        "creation": "create",
        "생성": "create",
        "delete": "delete",
        "deletion": "delete",
        "삭제": "delete",
        "forbidden": "forbidden",
        "forbid": "forbidden",
        "금지": "forbidden",
    }
    return aliases.get(normalized)


def _canonical_manifest_operation(value: str) -> str | None:
    normalized = value.strip().lower()
    if normalized in {"modify", "수정"}:
        return "modify"
    if normalized in {"create", "생성"}:
        return "create"
    if normalized in {"delete", "삭제"}:
        return "delete"
    if normalized in {"forbidden", "금지"}:
        return "forbidden"
    return None


def _operations_for_manifest_label(label: str) -> tuple[str, ...]:
    canonical = _canonical_manifest_operation(label) or label
    return _OPERATION_ALIASES.get(canonical, _ALL_OPERATIONS)


def _operations_for_manifest_pattern(label: str, pattern: str) -> tuple[str, ...]:
    canonical = _canonical_manifest_operation(label) or label
    if canonical == "modify" and pattern.endswith("/**"):
        return ("create", "modify")
    return _operations_for_manifest_label(label)


def _block_section_title(title: str) -> bool:
    lowered = title.lower()
    return "forbidden" in lowered or "금지" in title or "excluded" in lowered or "제외" in title


def _manifest_source_path(path: Path, repo_root: Path) -> str:
    try:
        return str(path.relative_to(repo_root))
    except ValueError:
        return str(path)


def _metadata_path(metadata: Mapping[str, Any], key: str) -> Path | None:
    value = metadata.get(key)
    if isinstance(value, str) and value.strip():
        return Path(value)
    return None


def _dedupe_patterns(patterns: Sequence[ScopePattern]) -> tuple[ScopePattern, ...]:
    seen: set[tuple[str, str, str, tuple[str, ...]]] = set()
    result: list[ScopePattern] = []
    for pattern in patterns:
        key = (pattern.pattern, pattern.source, pattern.kind, pattern.operations)
        if key not in seen:
            seen.add(key)
            result.append(pattern)
    return tuple(result)


def _relative_path(path: Path) -> Path:
    return Path(path.name) if path.is_absolute() else path


if __name__ == "__main__":
    raise SystemExit(main())
