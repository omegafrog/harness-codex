"""executor worktree 변경을 ChangeSet 범위와 대조한다."""

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

from harness_codex.runtime.changes.parser import parse_changeset_markdown


PATH_CODE_RE = re.compile(r"`([^`]+)`")
PATH_TOKEN_RE = re.compile(r"(?<![\w.-])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.*{}<>, -]+)+)")


@dataclass(frozen=True)
class ScopePattern:
    pattern: str
    source: str
    kind: str = "allow"


@dataclass(frozen=True)
class ScopeDiffResult:
    status: str
    report_path: Path
    blocked_files: tuple[str, ...]
    message: str | None = None


def capture_git_snapshot(repo_root: Path) -> dict[str, dict[str, str | None]]:
    """변경된 worktree 파일 상태를 비교 가능한 snapshot으로 기록한다."""

    if not _inside_git_work_tree(repo_root):
        return {}

    changed_paths = _git_changed_paths(repo_root)
    snapshot: dict[str, dict[str, str | None]] = {}
    for path in sorted(changed_paths):
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
    """범위 검증 report를 쓰고 범위 밖 파일 목록을 반환한다."""

    metadata = context_metadata or {}
    changed_files = _changed_between(before, after)
    allow_patterns, block_patterns = _scope_patterns(
        repo_root=repo_root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        metadata=metadata,
        runtime_allow_patterns=runtime_allow_patterns,
    )

    allowed: list[dict[str, Any]] = []
    suspicious: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    changed_rows: list[dict[str, Any]] = []

    for path in changed_files:
        block_matches = _matching_sources(path, block_patterns)
        allow_matches = _matching_sources(path, allow_patterns)
        row = {
            "path": path,
            "before": before.get(path),
            "after": after.get(path),
            "allowed_sources": allow_matches,
            "blocked_sources": block_matches,
        }
        changed_rows.append(row)
        if block_matches or not allow_matches:
            blocked.append(row)
        elif _is_suspicious_path(path, allow_matches):
            suspicious.append(row)
        else:
            allowed.append(row)

    status = "blocked" if blocked else "passed"
    source_summary = tuple(dict.fromkeys(pattern.source for pattern in allow_patterns))
    report = {
        "status": status,
        "run_id": run_id,
        "change_set_id": change_set_id,
        "work_item_id": work_item_id,
        "changed_files": changed_rows,
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
            + ". allowed scope sources: "
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
    if result.message:
        print(result.message)
    else:
        print(f"scope diff {result.status}: {result.report_path}")
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


def _scope_patterns(
    *,
    repo_root: Path,
    change_set_id: str,
    work_item_id: str,
    metadata: Mapping[str, Any],
    runtime_allow_patterns: Sequence[ScopePattern],
) -> tuple[tuple[ScopePattern, ...], tuple[ScopePattern, ...]]:
    allow: list[ScopePattern] = list(runtime_allow_patterns)
    block: list[ScopePattern] = []

    active_plan_path = _metadata_path(metadata, "active_plan_path")
    if active_plan_path:
        allow.append(ScopePattern(str(active_plan_path), "active plan output"))
        allow.extend(_patterns_from_markdown(repo_root / active_plan_path, "active plan"))

    change_set_path = _metadata_path(metadata, "change_set_path") or Path(
        f"docs/changes/active/{change_set_id}.md"
    )
    for pattern in _patterns_from_changeset(repo_root / change_set_path):
        if pattern.kind == "block":
            block.append(pattern)
        else:
            allow.append(pattern)

    for path in _affected_file_docs(repo_root, work_item_id, metadata):
        file_allow, file_block = _patterns_from_affected_files(path)
        allow.extend(file_allow)
        block.extend(file_block)

    return tuple(_dedupe_patterns(allow)), tuple(_dedupe_patterns(block))


def _patterns_from_changeset(path: Path) -> tuple[ScopePattern, ...]:
    if not path.is_file():
        return ()
    text = path.read_text(encoding="utf-8")
    change_set = parse_changeset_markdown(text, path=_relative_path(path))
    patterns: list[ScopePattern] = []
    for document in change_set.changed_documents:
        normalized = _normalize_path_token(str(document.path))
        if normalized:
            patterns.append(ScopePattern(normalized, "ChangeSet changed documents"))
    for item in change_set.included_scope:
        patterns.extend(
            ScopePattern(pattern, "ChangeSet included scope")
            for pattern in _extract_path_patterns(item)
        )
    for item in change_set.forbidden_changes + change_set.excluded_scope:
        patterns.extend(
            ScopePattern(pattern, "ChangeSet excluded/forbidden scope", "block")
            for pattern in _extract_path_patterns(item)
        )
    return tuple(patterns)


def _patterns_from_affected_files(
    path: Path,
) -> tuple[tuple[ScopePattern, ...], tuple[ScopePattern, ...]]:
    if not path.is_file():
        return (), ()
    text = path.read_text(encoding="utf-8")
    sections = _markdown_sections(text)
    allow_text = "\n".join(
        content
        for title, content in sections.items()
        if not _block_section_title(title)
    )
    block_text = "\n".join(
        content for title, content in sections.items() if _block_section_title(title)
    )
    allow = tuple(
        ScopePattern(pattern, f"affected-files {path.relative_to(path.parents[3])}")
        for pattern in _extract_path_patterns(allow_text)
    )
    block = tuple(
        ScopePattern(
            pattern,
            f"affected-files forbidden {path.relative_to(path.parents[3])}",
            "block",
        )
        for pattern in _extract_path_patterns(block_text)
    )
    return allow, block


def _patterns_from_markdown(path: Path, source: str) -> tuple[ScopePattern, ...]:
    if not path.is_file():
        return ()
    return tuple(
        ScopePattern(pattern, source)
        for pattern in _extract_path_patterns(path.read_text(encoding="utf-8"))
    )


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


def _matching_sources(path: str, patterns: Iterable[ScopePattern]) -> list[str]:
    return [
        pattern.source
        for pattern in patterns
        if _matches_pattern(path, pattern.pattern)
    ]


def _matches_pattern(path: str, pattern: str) -> bool:
    if pattern.endswith("/"):
        return path.startswith(pattern)
    if any(char in pattern for char in "*?[]"):
        return fnmatch.fnmatch(path, pattern)
    return path == pattern


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
        source in {"ChangeSet changed documents", "ChangeSet included scope"}
        or source.startswith("affected-files")
        for source in sources
    )


def _markdown_sections(text: str) -> dict[str, str]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", text, flags=re.MULTILINE))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[match.group(1).strip()] = text[start:end]
    if not sections:
        sections[""] = text
    return sections


def _block_section_title(title: str) -> bool:
    lowered = title.lower()
    return (
        "forbidden" in lowered
        or "금지" in title
        or "excluded" in lowered
        or "제외" in title
    )


def _metadata_path(metadata: Mapping[str, Any], key: str) -> Path | None:
    value = metadata.get(key)
    if isinstance(value, str) and value.strip():
        return Path(value)
    return None


def _dedupe_patterns(patterns: Sequence[ScopePattern]) -> tuple[ScopePattern, ...]:
    seen: set[tuple[str, str, str]] = set()
    result: list[ScopePattern] = []
    for pattern in patterns:
        key = (pattern.pattern, pattern.source, pattern.kind)
        if key not in seen:
            seen.add(key)
            result.append(pattern)
    return tuple(result)


def _relative_path(path: Path) -> Path:
    return Path(path.name) if path.is_absolute() else path


if __name__ == "__main__":
    raise SystemExit(main())
