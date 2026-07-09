"""Validate executor writes against protected harness paths and plan boundaries.

The executor write boundary is intentionally simple:

* harness/control-plane files are protected and blocked for non-evolve runs;
* application source writes must stay inside the plan implementation boundary;
* tests must stay inside the matching test boundary;
* build/config/script files require explicit plan exceptions;
* runtime artifacts are allowed only under runtime-owned output paths.
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
from harness_codex.runtime.scope_support_manifest import load_scope_support_patterns


PATH_CODE_RE = re.compile(r"`([^`]+)`")
PATH_TOKEN_RE = re.compile(r"(?<![\w.-])([A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.*{}<>, -]+)+)")
_ALL_OPERATIONS = ("modify", "create", "delete")
_CODE_SUFFIXES = {
    ".py",
    ".java",
    ".kt",
    ".kts",
    ".groovy",
    ".js",
    ".jsx",
    ".ts",
    ".tsx",
    ".go",
    ".rs",
    ".rb",
    ".php",
    ".swift",
    ".scala",
    ".c",
    ".cc",
    ".cpp",
    ".cxx",
    ".h",
    ".hpp",
    ".cs",
}
_CONFIG_SUFFIXES = {
    ".xml",
    ".yml",
    ".yaml",
    ".properties",
    ".toml",
    ".ini",
    ".conf",
    ".env",
    ".sql",
}
_BUILD_CONFIG_NAMES = {
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle.properties",
    "pom.xml",
    "pyproject.toml",
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "compose.yaml",
    "compose.yml",
    "docker-compose.yml",
    "docker-compose.yaml",
    "Dockerfile",
    "gradlew",
    "gradlew.bat",
    "mvnw",
    "mvnw.cmd",
}
_CONFIG_DIRS = {
    ".github",
    ".mvn",
    "config",
    "configs",
    "docker",
    "gradle",
    "script",
    "scripts",
}


@dataclass(frozen=True)
class ScopePattern:
    pattern: str
    source: str
    kind: str = "allow"
    operations: tuple[str, ...] = _ALL_OPERATIONS


@dataclass(frozen=True)
class ImplementationBoundary:
    """Plan-declared executor implementation boundary."""

    source: tuple[ScopePattern, ...] = ()
    tests: tuple[ScopePattern, ...] = ()
    config_exceptions: tuple[ScopePattern, ...] = ()
    runtime_artifacts: tuple[ScopePattern, ...] = ()
    protected: tuple[ScopePattern, ...] = ()
    present: bool = False


@dataclass(frozen=True)
class ScopePolicy:
    """Authority inputs used by the executor scope boundary."""

    runtime_allow: tuple[ScopePattern, ...] = ()
    changeset_allow: tuple[ScopePattern, ...] = ()
    manifest_allow: tuple[ScopePattern, ...] = ()
    blocked: tuple[ScopePattern, ...] = ()
    boundary: ImplementationBoundary = ImplementationBoundary()


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
    """Write a scope report and block executor writes outside runtime policy."""

    metadata = context_metadata or {}
    policy = _scope_policy(
        repo_root=repo_root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        metadata=metadata,
        runtime_allow_patterns=runtime_allow_patterns,
    )
    changed_files = _changed_between(before, after)
    evolve = is_evolve_context(metadata)

    allowed: list[dict[str, Any]] = []
    suspicious: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    changed_rows: list[dict[str, Any]] = []

    for path in changed_files:
        operation = _change_operation(repo_root, path, before.get(path), after.get(path))
        category = _path_category(path)
        runtime_matches = _matching_sources(path, policy.runtime_allow, operation)
        boundary_runtime_matches = _matching_sources(path, policy.boundary.runtime_artifacts, operation)
        boundary_source_matches = _matching_sources(path, policy.boundary.source, operation)
        boundary_test_matches = _matching_sources(path, policy.boundary.tests, operation)
        config_exception_matches = _matching_sources(path, policy.boundary.config_exceptions, operation)
        changeset_matches = _matching_sources(path, policy.changeset_allow, operation)
        manifest_matches = _matching_sources(path, policy.manifest_allow, operation)
        block_matches = _matching_sources(path, (*policy.blocked, *policy.boundary.protected), operation)

        decision, reason, allowed_sources = _classify_change(
            path=path,
            category=category,
            evolve=evolve,
            boundary_present=policy.boundary.present,
            runtime_matches=runtime_matches,
            boundary_runtime_matches=boundary_runtime_matches,
            boundary_source_matches=boundary_source_matches,
            boundary_test_matches=boundary_test_matches,
            config_exception_matches=config_exception_matches,
            changeset_matches=changeset_matches,
            manifest_matches=manifest_matches,
            block_matches=block_matches,
        )
        row = {
            "path": path,
            "operation": operation,
            "category": category,
            "decision": decision,
            "reason": reason,
            "before": before.get(path),
            "after": after.get(path),
            "allowed_sources": allowed_sources,
            "boundary_source_sources": boundary_source_matches,
            "boundary_test_sources": boundary_test_matches,
            "config_exception_sources": config_exception_matches,
            "boundary_runtime_sources": boundary_runtime_matches,
            "change_set_sources": changeset_matches,
            "manifest_sources": manifest_matches,
            "runtime_sources": runtime_matches,
            "blocked_sources": block_matches,
        }
        changed_rows.append(row)
        if decision == "blocked":
            blocked.append(row)
        elif decision == "suspicious" or _is_suspicious_path(path, allowed_sources):
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
            "implementation_write_allowlist": "plan implementationBoundary module boundary",
            "protected_control_plane_writes_blocked": not evolve,
            "source_code_requires_plan_module_boundary": True,
            "config_build_script_requires_explicit_exception": True,
            "plan_paths_grant_repository_wide_authority": False,
            "boundary_present": policy.boundary.present,
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
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    blocked_files = tuple(row["path"] for row in blocked)
    message = None
    if blocked_files:
        message = (
            "scope diff blocked executor writes: "
            + ", ".join(blocked_files)
            + ". source code must stay inside plan implementationBoundary; "
            "build/config/script files require explicit exceptions; "
            "harness control-plane files are protected."
        )
    return ScopeDiffResult(status=status, report_path=report_path, blocked_files=blocked_files, message=message)


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


def _classify_change(
    *,
    path: str,
    category: str,
    evolve: bool,
    boundary_present: bool,
    runtime_matches: Sequence[str],
    boundary_runtime_matches: Sequence[str],
    boundary_source_matches: Sequence[str],
    boundary_test_matches: Sequence[str],
    config_exception_matches: Sequence[str],
    changeset_matches: Sequence[str],
    manifest_matches: Sequence[str],
    block_matches: Sequence[str],
) -> tuple[str, str, list[str]]:
    runtime_sources = list(dict.fromkeys([*runtime_matches, *boundary_runtime_matches]))
    if runtime_sources:
        return "allowed", "runtime artifact boundary", runtime_sources
    if block_matches and not evolve:
        return "blocked", "protected harness control-plane path", list(block_matches)
    if block_matches and evolve:
        return "allowed", "evolve run may update control-plane path", list(block_matches)

    if category == "config_build_script":
        if config_exception_matches:
            return "allowed", "explicit config/build/script exception", list(config_exception_matches)
        if not boundary_present and (changeset_matches or manifest_matches):
            return "allowed", "legacy support-file scope", list(dict.fromkeys([*changeset_matches, *manifest_matches]))
        return "blocked", "build/config/script files require explicit plan exception", []

    if category == "test":
        if boundary_test_matches:
            return "allowed", "plan implementationBoundary.tests", list(boundary_test_matches)
        if not boundary_present and (changeset_matches or manifest_matches):
            return "allowed", "legacy test scope", list(dict.fromkeys([*changeset_matches, *manifest_matches]))
        return "blocked", "test file outside plan implementationBoundary.tests", []

    if category == "source":
        if boundary_source_matches:
            return "allowed", "plan implementationBoundary.source", list(boundary_source_matches)
        if not boundary_present and (changeset_matches or manifest_matches):
            return "allowed", "legacy source scope", list(dict.fromkeys([*changeset_matches, *manifest_matches]))
        return "blocked", "source file outside plan implementationBoundary.source", []

    fallback_sources = list(dict.fromkeys([*boundary_source_matches, *boundary_test_matches, *changeset_matches]))
    if fallback_sources:
        return "allowed", "non-source path explicitly scoped", fallback_sources
    if manifest_matches and not boundary_present:
        return "allowed", "legacy repository support manifest", list(manifest_matches)
    return "blocked", "path is not covered by runtime artifacts or plan boundary", []


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
        completed = subprocess.run(command, cwd=repo_root, text=True, capture_output=True, check=False)
        if completed.returncode != 0:
            continue
        for line in completed.stdout.splitlines():
            normalized = _normalize_path_token(line)
            if not normalized:
                continue
            absolute = repo_root / normalized
            if absolute.is_dir():
                paths.update(str(path.relative_to(repo_root)) for path in absolute.rglob("*") if path.is_file())
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


def _changed_between(before: Mapping[str, Mapping[str, str | None]], after: Mapping[str, Mapping[str, str | None]]) -> tuple[str, ...]:
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
                files.append({"path": path, "status": _diff_status_from_operation(operation), "operation": operation})
        mapped.append({"work_item_id": work_item_id, "line": task["line"], "checked": task["checked"], "text": task["text"], "files": files, "match": "plan-task-token"})
    return mapped


def _active_plan_path(repo_root: Path, work_item_id: str, metadata: Mapping[str, Any]) -> Path | None:
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
            tasks.append({"line": line_number, "checked": match.group(1).lower() == "x", "text": match.group(2).strip()})
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
    runtime_allow = [*_runtime_generated_output_patterns(), *runtime_allow_patterns]
    active_plan_path = _metadata_path(metadata, "active_plan_path")
    if active_plan_path:
        runtime_allow.append(ScopePattern(str(active_plan_path), "executor-owned active plan state"))

    boundary = _implementation_boundary(repo_root, work_item_id, metadata)
    for pattern in boundary.runtime_artifacts:
        runtime_allow.append(pattern)

    changeset_allow: list[ScopePattern] = []
    blocked: list[ScopePattern] = []
    change_set_path = _metadata_path(metadata, "change_set_path") or Path(f"docs/changes/active/{change_set_id}.md")
    for pattern in _patterns_from_changeset(repo_root / change_set_path):
        if pattern.kind == "block":
            blocked.append(pattern)
        else:
            changeset_allow.append(pattern)
    if not changeset_allow:
        changeset_allow.extend(_patterns_from_active_plan_execution_scope(repo_root, work_item_id, metadata))
        changeset_allow.extend(_patterns_from_active_plan_task_checklist(repo_root, work_item_id, metadata))

    manifest_allow = [ScopePattern(pattern, "repository scope support manifest") for pattern in load_scope_support_patterns(repo_root)]

    if not is_evolve_context(metadata):
        blocked.extend(ScopePattern(pattern, "protected harness control-plane", "block") for pattern in control_plane_block_patterns())

    return ScopePolicy(
        runtime_allow=tuple(_dedupe_patterns(runtime_allow)),
        changeset_allow=tuple(_dedupe_patterns(changeset_allow)),
        manifest_allow=tuple(_dedupe_patterns(manifest_allow)),
        blocked=tuple(_dedupe_patterns(blocked)),
        boundary=boundary,
    )


def _runtime_generated_output_patterns() -> tuple[ScopePattern, ...]:
    return (
        *(ScopePattern(pattern, source) for pattern, source in runtime_output_allow_patterns()),
        *(ScopePattern(pattern, source) for pattern, source in project_output_allow_patterns()),
    )


def _implementation_boundary(repo_root: Path, work_item_id: str, metadata: Mapping[str, Any]) -> ImplementationBoundary:
    plan_path = _active_plan_path(repo_root, work_item_id, metadata)
    if plan_path is None or not plan_path.is_file():
        return ImplementationBoundary()
    parsed = _parse_implementation_boundary(plan_path.read_text(encoding="utf-8"))
    if not parsed:
        return ImplementationBoundary()
    source = _patterns_from_boundary_values(parsed.get("source", ()), "plan implementationBoundary.source")
    tests = _patterns_from_boundary_values(parsed.get("tests", ()), "plan implementationBoundary.tests")
    config = _patterns_from_boundary_values(parsed.get("configExceptions", ()), "plan implementationBoundary.configExceptions")
    runtime = _patterns_from_boundary_values(parsed.get("runtimeArtifacts", ()), "plan implementationBoundary.runtimeArtifacts")
    protected = _patterns_from_boundary_values(parsed.get("protected", ()), "plan implementationBoundary.protected", kind="block")
    return ImplementationBoundary(
        source=source,
        tests=tests,
        config_exceptions=config,
        runtime_artifacts=runtime,
        protected=protected,
        present=True,
    )


def _parse_implementation_boundary(text: str) -> dict[str, tuple[str, ...]]:
    lines = text.splitlines()
    start = next((index for index, line in enumerate(lines) if re.match(r"^\s*implementationBoundary\s*:\s*$", line)), None)
    if start is None:
        return {}
    result: dict[str, list[str]] = {}
    current_key = ""
    base_indent = len(lines[start]) - len(lines[start].lstrip())
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if not stripped or stripped in {"```", "~~~"}:
            continue
        indent = len(line) - len(line.lstrip())
        if indent <= base_indent and re.match(r"^[A-Za-z0-9_-]+\s*:", stripped):
            break
        key_match = re.match(r"^\s{0,4}([A-Za-z][A-Za-z0-9_]*)\s*:\s*(?:#.*)?$", line)
        if key_match:
            current_key = key_match.group(1)
            result.setdefault(current_key, [])
            continue
        item_match = re.match(r"^\s*-\s+(.+?)\s*$", line)
        if item_match and current_key:
            normalized = _normalize_path_token(item_match.group(1).strip().strip('"\''))
            if normalized:
                result.setdefault(current_key, []).append(normalized)
    return {key: tuple(dict.fromkeys(values)) for key, values in result.items()}


def _patterns_from_boundary_values(values: Sequence[str], source: str, *, kind: str = "allow") -> tuple[ScopePattern, ...]:
    patterns: list[ScopePattern] = []
    for value in values:
        for expanded in _expand_brace_pattern(value):
            patterns.append(ScopePattern(expanded, source, kind))
    return tuple(_dedupe_patterns(patterns))


def _patterns_from_changeset(path: Path) -> tuple[ScopePattern, ...]:
    if not path.is_file():
        return ()
    text = path.read_text(encoding="utf-8")
    change_set = parse_changeset_markdown(text, path=_relative_path(path))
    patterns: list[ScopePattern] = []
    for item in change_set.included_scope:
        patterns.extend(ScopePattern(pattern, "ChangeSet included scope") for pattern in _extract_path_patterns(item))
    for item in change_set.forbidden_changes + change_set.excluded_scope:
        patterns.extend(ScopePattern(pattern, "ChangeSet excluded/forbidden scope", "block") for pattern in _extract_path_patterns(item))
    return tuple(patterns)


def _patterns_from_active_plan_execution_scope(repo_root: Path, work_item_id: str, metadata: Mapping[str, Any]) -> tuple[ScopePattern, ...]:
    plan_path = _active_plan_path(repo_root, work_item_id, metadata)
    if plan_path is None or not plan_path.is_file():
        return ()
    sections = _markdown_h2_sections(plan_path.read_text(encoding="utf-8"))
    content = ""
    for heading in ("실행 경계", "Execution Scope"):
        if heading in sections:
            content = sections[heading]
            break
    if not content:
        return ()
    allowed_content = _markdown_h3_subsection(content, "수정 허용 경로", "Allowed Paths", "Allowed paths", "Included Paths", "Included paths")
    if not allowed_content:
        return ()
    patterns: list[ScopePattern] = []
    for pattern in _extract_path_patterns(allowed_content):
        for expanded in _expand_brace_pattern(pattern):
            patterns.append(ScopePattern(expanded, "approved active plan execution scope"))
    return tuple(patterns)


def _patterns_from_active_plan_task_checklist(repo_root: Path, work_item_id: str, metadata: Mapping[str, Any]) -> tuple[ScopePattern, ...]:
    plan_path = _active_plan_path(repo_root, work_item_id, metadata)
    if plan_path is None or not plan_path.is_file():
        return ()
    sections = _markdown_h2_sections(plan_path.read_text(encoding="utf-8"))
    content = ""
    for heading in ("작업 체크리스트", "Task Checklist"):
        if heading in sections:
            content = sections[heading]
            break
    if not content:
        return ()
    patterns: list[ScopePattern] = []
    for pattern in _extract_path_patterns(content):
        for expanded in _expand_brace_pattern(pattern):
            patterns.append(ScopePattern(expanded, "approved active plan task checklist"))
    return tuple(patterns)


def _change_operation(repo_root: Path, path: str, before: Mapping[str, str | None] | None, after: Mapping[str, str | None] | None) -> str:
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
    completed = subprocess.run(["git", "ls-files", "--error-unmatch", "--", path], cwd=repo_root, text=True, capture_output=True, check=False)
    return completed.returncode == 0


def _snapshot_exists(snapshot: Mapping[str, str | None] | None) -> bool:
    return bool(snapshot) and snapshot.get("state") not in {None, "missing"}


def _matching_sources(path: str, patterns: Iterable[ScopePattern], operation: str) -> list[str]:
    return [pattern.source for pattern in patterns if operation in pattern.operations and _matches_pattern(path, pattern.pattern)]


def _matches_pattern(path: str, pattern: str) -> bool:
    if pattern.endswith("/"):
        return path.startswith(pattern)
    if any(char in pattern for char in "*?[]"):
        return fnmatch.fnmatch(path, pattern)
    return path == pattern


def _policy_source_summary(policy: ScopePolicy) -> tuple[str, ...]:
    return tuple(
        dict.fromkeys(
            [
                *(pattern.source for pattern in policy.runtime_allow),
                *(pattern.source for pattern in policy.boundary.source),
                *(pattern.source for pattern in policy.boundary.tests),
                *(pattern.source for pattern in policy.boundary.config_exceptions),
                *(pattern.source for pattern in policy.changeset_allow),
                *(pattern.source for pattern in policy.manifest_allow),
            ]
        )
    )


def _is_suspicious_path(path: str, sources: Sequence[str]) -> bool:
    return _is_config_build_script_path(path) and not any("configExceptions" in source or "ChangeSet included scope" in source for source in sources)


def _path_category(path: str) -> str:
    if _is_config_build_script_path(path):
        return "config_build_script"
    if _is_test_path(path):
        return "test"
    if _is_source_code_path(path):
        return "source"
    return "other"


def _is_source_code_path(path: str) -> bool:
    return Path(path).suffix in _CODE_SUFFIXES


def _is_test_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    parts = tuple(part for part in normalized.split("/") if part)
    name = parts[-1] if parts else normalized
    return (
        normalized.startswith("tests/")
        or normalized.startswith("test/")
        or normalized.startswith("src/test/")
        or "/test/" in normalized
        or name.startswith("test_")
        or name.endswith("_test.py")
        or name.endswith("Test.java")
        or name.endswith("Test.kt")
        or name.endswith("Spec.ts")
        or name.endswith(".spec.ts")
        or name.endswith(".test.ts")
    )


def _is_config_build_script_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    parts = tuple(part for part in normalized.split("/") if part)
    name = parts[-1] if parts else normalized
    if name in _BUILD_CONFIG_NAMES or name.startswith("Dockerfile"):
        return True
    if parts and parts[0] in _CONFIG_DIRS:
        return True
    if normalized.startswith(("src/main/resources/", "src/test/resources/")):
        return True
    return Path(name).suffix in _CONFIG_SUFFIXES and not _is_source_code_path(path)


def _extract_path_patterns(text: str) -> tuple[str, ...]:
    values: list[str] = []
    values.extend(match.group(1) for match in PATH_CODE_RE.finditer(text))
    values.extend(match.group(1) for match in PATH_TOKEN_RE.finditer(text))
    return tuple(dict.fromkeys(normalized for value in values if (normalized := _normalize_path_token(value))))


def _expand_brace_pattern(pattern: str) -> tuple[str, ...]:
    match = re.search(r"\{([^{}]+)\}", pattern)
    if not match:
        return (pattern,)
    options = [option.strip() for option in match.group(1).split(",") if option.strip()]
    if not options:
        return ()
    expanded = [pattern[: match.start()] + option + pattern[match.end() :] for option in options if "/" not in option]
    return tuple(expanded) if expanded else ()


def _normalize_path_token(value: str) -> str:
    token = value.strip().strip("|,;:)").strip("`\"")
    token = token.removeprefix("./")
    if not token or "://" in token:
        return ""
    if "<" in token or ">" in token or "..." in token:
        return ""
    if token.startswith("/"):
        return ""
    return token


def _markdown_h2_sections(text: str) -> dict[str, str]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", text, flags=re.MULTILINE))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        sections[match.group(1).strip()] = text[start:end]
    return sections


def _markdown_h3_subsection(text: str, *names: str) -> str:
    matches = list(re.finditer(r"^###\s+(.+?)\s*$", text, flags=re.MULTILINE))
    wanted = set(names)
    for index, match in enumerate(matches):
        if match.group(1).strip() not in wanted:
            continue
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        return text[start:end]
    return ""


def _metadata_path(metadata: Mapping[str, Any], key: str) -> Path | None:
    value = metadata.get(key)
    if isinstance(value, Path):
        return value
    if isinstance(value, str) and value.strip():
        return Path(value.strip())
    return None


def _relative_path(path: Path) -> Path:
    try:
        return path.relative_to(Path.cwd())
    except ValueError:
        return path


def _dedupe_patterns(patterns: Iterable[ScopePattern]) -> tuple[ScopePattern, ...]:
    seen: set[tuple[str, str, str, tuple[str, ...]]] = set()
    deduped: list[ScopePattern] = []
    for pattern in patterns:
        key = (pattern.pattern, pattern.source, pattern.kind, pattern.operations)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(pattern)
    return tuple(deduped)


if __name__ == "__main__":
    raise SystemExit(main())
