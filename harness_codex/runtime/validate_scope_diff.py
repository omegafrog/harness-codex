"""Validate executor writes against protected harness paths and plan boundaries."""

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
_CODE_SUFFIXES = {".py", ".java", ".kt", ".kts", ".groovy", ".js", ".jsx", ".ts", ".tsx", ".go", ".rs", ".rb", ".php", ".swift", ".scala", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".cs"}
_CONFIG_SUFFIXES = {".xml", ".yml", ".yaml", ".properties", ".toml", ".ini", ".conf", ".env", ".sql"}
_BUILD_CONFIG_NAMES = {"build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", "gradle.properties", "pom.xml", "pyproject.toml", "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml", "Dockerfile", "gradlew", "gradlew.bat", "mvnw", "mvnw.cmd"}
_CONFIG_DIRS = {".github", ".mvn", "config", "configs", "docker", "gradle", "script", "scripts"}


@dataclass(frozen=True)
class ScopePattern:
    pattern: str
    source: str
    kind: str = "allow"
    operations: tuple[str, ...] = _ALL_OPERATIONS


@dataclass(frozen=True)
class ImplementationBoundary:
    source: tuple[ScopePattern, ...] = ()
    tests: tuple[ScopePattern, ...] = ()
    config_exceptions: tuple[ScopePattern, ...] = ()
    runtime_artifacts: tuple[ScopePattern, ...] = ()
    protected: tuple[ScopePattern, ...] = ()
    present: bool = False


@dataclass(frozen=True)
class ScopePolicy:
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
    if not _inside_git_work_tree(repo_root):
        return {}
    snapshot: dict[str, dict[str, str | None]] = {}
    for path in sorted(_git_changed_paths(repo_root)):
        absolute = repo_root / path
        snapshot[path] = {"path": path, "state": _file_state(absolute), "sha256": _sha256(absolute)}
    return snapshot


def write_snapshot(path: Path, snapshot: Mapping[str, Mapping[str, str | None]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


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
    metadata = context_metadata or {}
    policy = _scope_policy(repo_root=repo_root, change_set_id=change_set_id, work_item_id=work_item_id, metadata=metadata, runtime_allow_patterns=runtime_allow_patterns)
    evolve = is_evolve_context(metadata)
    allowed: list[dict[str, Any]] = []
    suspicious: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    changed_rows: list[dict[str, Any]] = []

    for path in _changed_between(before, after):
        operation = _change_operation(repo_root, path, before.get(path), after.get(path))
        category = _path_category(path)
        matches = {
            "runtime": _matching_sources(path, policy.runtime_allow, operation),
            "boundary_runtime": _matching_sources(path, policy.boundary.runtime_artifacts, operation),
            "boundary_source": _matching_sources(path, policy.boundary.source, operation),
            "boundary_test": _matching_sources(path, policy.boundary.tests, operation),
            "config_exception": _matching_sources(path, policy.boundary.config_exceptions, operation),
            "changeset": _matching_sources(path, policy.changeset_allow, operation),
            "manifest": _matching_sources(path, policy.manifest_allow, operation),
            "blocked": _matching_sources(path, (*policy.blocked, *policy.boundary.protected), operation),
        }
        decision, reason, allowed_sources = _classify_change(category=category, evolve=evolve, boundary_present=policy.boundary.present, matches=matches)
        row = {
            "path": path,
            "operation": operation,
            "category": category,
            "decision": decision,
            "reason": reason,
            "before": before.get(path),
            "after": after.get(path),
            "allowed_sources": allowed_sources,
            "boundary_source_sources": matches["boundary_source"],
            "boundary_test_sources": matches["boundary_test"],
            "config_exception_sources": matches["config_exception"],
            "boundary_runtime_sources": matches["boundary_runtime"],
            "change_set_sources": matches["changeset"],
            "manifest_sources": matches["manifest"],
            "runtime_sources": matches["runtime"],
            "blocked_sources": matches["blocked"],
        }
        changed_rows.append(row)
        if decision == "blocked":
            blocked.append(row)
        elif decision == "suspicious" or _is_suspicious_path(path, allowed_sources):
            suspicious.append(row)
        else:
            allowed.append(row)

    status = "blocked" if blocked else "passed"
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
        "plan_task_file_map": [],
        "allowed": allowed,
        "suspicious": suspicious,
        "blocked": blocked,
        "allowed_scope_sources": _policy_source_summary(policy),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    blocked_files = tuple(row["path"] for row in blocked)
    message = None
    if blocked_files:
        message = (
            "scope diff blocked executor writes: " + ", ".join(blocked_files)
            + ". source code must stay inside plan implementationBoundary; build/config/script files require explicit exceptions; harness control-plane files are protected."
        )
    return ScopeDiffResult(status=status, report_path=report_path, blocked_files=blocked_files, message=message)


def _classify_change(*, category: str, evolve: bool, boundary_present: bool, matches: Mapping[str, Sequence[str]]) -> tuple[str, str, list[str]]:
    runtime_sources = list(dict.fromkeys([*matches["runtime"], *matches["boundary_runtime"]]))
    if runtime_sources:
        return "allowed", "runtime artifact boundary", runtime_sources
    if matches["blocked"] and not evolve:
        return "blocked", "protected harness control-plane path", list(matches["blocked"])
    if matches["blocked"] and evolve:
        return "allowed", "evolve run may update control-plane path", list(matches["blocked"])
    if category == "config_build_script":
        if matches["config_exception"]:
            return "allowed", "explicit config/build/script exception", list(matches["config_exception"])
        if not boundary_present and (matches["changeset"] or matches["manifest"]):
            return "allowed", "legacy support-file scope", list(dict.fromkeys([*matches["changeset"], *matches["manifest"]]))
        return "blocked", "build/config/script files require explicit plan exception", []
    if category == "test":
        if matches["boundary_test"]:
            return "allowed", "plan implementationBoundary.tests", list(matches["boundary_test"])
        if not boundary_present and (matches["changeset"] or matches["manifest"]):
            return "allowed", "legacy test scope", list(dict.fromkeys([*matches["changeset"], *matches["manifest"]]))
        return "blocked", "test file outside plan implementationBoundary.tests", []
    if category == "source":
        if matches["boundary_source"]:
            return "allowed", "plan implementationBoundary.source", list(matches["boundary_source"])
        if not boundary_present and (matches["changeset"] or matches["manifest"]):
            return "allowed", "legacy source scope", list(dict.fromkeys([*matches["changeset"], *matches["manifest"]]))
        return "blocked", "source file outside plan implementationBoundary.source", []
    fallback = list(dict.fromkeys([*matches["boundary_source"], *matches["boundary_test"], *matches["changeset"]]))
    if fallback:
        return "allowed", "non-source path explicitly scoped", fallback
    if matches["manifest"] and not boundary_present:
        return "allowed", "legacy repository support manifest", list(matches["manifest"])
    return "blocked", "path is not covered by runtime artifacts or plan boundary", []


def _scope_policy(*, repo_root: Path, change_set_id: str, work_item_id: str, metadata: Mapping[str, Any], runtime_allow_patterns: Sequence[ScopePattern]) -> ScopePolicy:
    runtime_allow = [*_runtime_generated_output_patterns(), *runtime_allow_patterns]
    active_plan_path = _metadata_path(metadata, "active_plan_path")
    if active_plan_path:
        runtime_allow.append(ScopePattern(str(active_plan_path), "executor-owned active plan state"))
    boundary = _implementation_boundary(repo_root, work_item_id, metadata)
    runtime_allow.extend(boundary.runtime_artifacts)

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
    return ScopePolicy(tuple(_dedupe_patterns(runtime_allow)), tuple(_dedupe_patterns(changeset_allow)), tuple(_dedupe_patterns(manifest_allow)), tuple(_dedupe_patterns(blocked)), boundary)


def _implementation_boundary(repo_root: Path, work_item_id: str, metadata: Mapping[str, Any]) -> ImplementationBoundary:
    plan_path = _active_plan_path(repo_root, work_item_id, metadata)
    if plan_path is None or not plan_path.is_file():
        return ImplementationBoundary()
    parsed = _parse_implementation_boundary(plan_path.read_text(encoding="utf-8"))
    if not parsed:
        return ImplementationBoundary()
    return ImplementationBoundary(
        source=_patterns_from_boundary_values(parsed.get("source", ()), "plan implementationBoundary.source"),
        tests=_patterns_from_boundary_values(parsed.get("tests", ()), "plan implementationBoundary.tests"),
        config_exceptions=_patterns_from_boundary_values(parsed.get("configExceptions", ()), "plan implementationBoundary.configExceptions"),
        runtime_artifacts=_patterns_from_boundary_values(parsed.get("runtimeArtifacts", ()), "plan implementationBoundary.runtimeArtifacts"),
        protected=_patterns_from_boundary_values(parsed.get("protected", ()), "plan implementationBoundary.protected", kind="block"),
        present=True,
    )


def _parse_implementation_boundary(text: str) -> dict[str, tuple[str, ...]]:
    lines = text.splitlines()
    start = next((i for i, line in enumerate(lines) if re.match(r"^\s*implementationBoundary\s*:\s*$", line)), None)
    if start is None:
        return {}
    result: dict[str, list[str]] = {}
    current_key = ""
    base_indent = len(lines[start]) - len(lines[start].lstrip())
    for line in lines[start + 1:]:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped in {"```", "~~~"} or stripped.startswith("#"):
            break
        indent = len(line) - len(line.lstrip())
        if indent <= base_indent and not stripped.startswith("-"):
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
    return tuple(_dedupe_patterns(ScopePattern(expanded, source, kind) for value in values for expanded in _expand_brace_pattern(value)))


def _runtime_generated_output_patterns() -> tuple[ScopePattern, ...]:
    return (*(ScopePattern(pattern, source) for pattern, source in runtime_output_allow_patterns()), *(ScopePattern(pattern, source) for pattern, source in project_output_allow_patterns()))


def _patterns_from_changeset(path: Path) -> tuple[ScopePattern, ...]:
    if not path.is_file():
        return ()
    change_set = parse_changeset_markdown(path.read_text(encoding="utf-8"), path=_relative_path(path))
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
    content = _section(plan_path.read_text(encoding="utf-8"), ("실행 경계", "Execution Scope"))
    allowed_content = _subsection(content, ("수정 허용 경로", "Allowed Paths", "Allowed paths", "Included Paths", "Included paths"))
    return tuple(ScopePattern(expanded, "approved active plan execution scope") for pattern in _extract_path_patterns(allowed_content) for expanded in _expand_brace_pattern(pattern))


def _patterns_from_active_plan_task_checklist(repo_root: Path, work_item_id: str, metadata: Mapping[str, Any]) -> tuple[ScopePattern, ...]:
    plan_path = _active_plan_path(repo_root, work_item_id, metadata)
    if plan_path is None or not plan_path.is_file():
        return ()
    content = _section(plan_path.read_text(encoding="utf-8"), ("작업 체크리스트", "Task Checklist"))
    return tuple(ScopePattern(expanded, "approved active plan task checklist") for pattern in _extract_path_patterns(content) for expanded in _expand_brace_pattern(pattern))


def _changed_between(before: Mapping[str, Mapping[str, str | None]], after: Mapping[str, Mapping[str, str | None]]) -> tuple[str, ...]:
    return tuple(sorted(path for path in set(before) | set(after) if before.get(path) != after.get(path)))


def _change_operation(repo_root: Path, path: str, before: Mapping[str, str | None] | None, after: Mapping[str, str | None] | None) -> str:
    if not _snapshot_exists(before) and _snapshot_exists(after):
        return "modify" if _git_tracks_path(repo_root, path) else "create"
    if _snapshot_exists(before) and not _snapshot_exists(after):
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
    return tuple(dict.fromkeys([*(p.source for p in policy.runtime_allow), *(p.source for p in policy.boundary.source), *(p.source for p in policy.boundary.tests), *(p.source for p in policy.boundary.config_exceptions), *(p.source for p in policy.changeset_allow), *(p.source for p in policy.manifest_allow)]))


def _is_suspicious_path(path: str, sources: Sequence[str]) -> bool:
    return _is_config_build_script_path(path) and not any("configExceptions" in source or "ChangeSet included scope" in source for source in sources)


def _path_category(path: str) -> str:
    if _is_config_build_script_path(path):
        return "config_build_script"
    if _is_test_path(path):
        return "test"
    if Path(path).suffix in _CODE_SUFFIXES:
        return "source"
    return "other"


def _is_test_path(path: str) -> bool:
    normalized = path.replace("\\", "/")
    name = normalized.rsplit("/", 1)[-1]
    return normalized.startswith(("tests/", "test/", "src/test/")) or "/test/" in normalized or name.startswith("test_") or name.endswith(("_test.py", "Test.java", "Test.kt", "Spec.ts", ".spec.ts", ".test.ts"))


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
    return Path(name).suffix in _CONFIG_SUFFIXES and Path(name).suffix not in _CODE_SUFFIXES


def _active_plan_path(repo_root: Path, work_item_id: str, metadata: Mapping[str, Any]) -> Path | None:
    raw_path = metadata.get("active_plan_path")
    if isinstance(raw_path, str) and raw_path:
        return repo_root / raw_path
    fallback = repo_root / "docs" / "plans" / "active" / work_item_id / "plan.md"
    if fallback.exists():
        return fallback
    completed = repo_root / "docs" / "plans" / "completed" / work_item_id / "plan.md"
    return completed if completed.exists() else None


def _section(text: str, names: Sequence[str]) -> str:
    sections = _markdown_h2_sections(text)
    return next((sections[name] for name in names if name in sections), "")


def _subsection(text: str, names: Sequence[str]) -> str:
    matches = list(re.finditer(r"^###\s+(.+?)\s*$", text, flags=re.MULTILINE))
    for index, match in enumerate(matches):
        if match.group(1).strip() not in names:
            continue
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        return text[start:end]
    return ""


def _markdown_h2_sections(text: str) -> dict[str, str]:
    matches = list(re.finditer(r"^##\s+(.+?)\s*$", text, flags=re.MULTILINE))
    return {m.group(1).strip(): text[m.end(): matches[i + 1].start() if i + 1 < len(matches) else len(text)] for i, m in enumerate(matches)}


def _extract_path_patterns(text: str) -> tuple[str, ...]:
    values = [m.group(1) for m in PATH_CODE_RE.finditer(text)] + [m.group(1) for m in PATH_TOKEN_RE.finditer(text)]
    return tuple(dict.fromkeys(normalized for value in values if (normalized := _normalize_path_token(value))))


def _expand_brace_pattern(pattern: str) -> tuple[str, ...]:
    match = re.search(r"\{([^{}]+)\}", pattern)
    if not match:
        return (pattern,)
    options = [option.strip() for option in match.group(1).split(",") if option.strip()]
    return tuple(pattern[: match.start()] + option + pattern[match.end():] for option in options if "/" not in option)


def _normalize_path_token(value: str) -> str:
    token = value.strip().strip("|,;:)").strip("`\"").removeprefix("./")
    if not token or "://" in token or "<" in token or ">" in token or "..." in token or token.startswith("/"):
        return ""
    return token


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
    result: list[ScopePattern] = []
    for pattern in patterns:
        key = (pattern.pattern, pattern.source, pattern.kind, pattern.operations)
        if key not in seen:
            seen.add(key)
            result.append(pattern)
    return tuple(result)


def _inside_git_work_tree(repo_root: Path) -> bool:
    completed = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"], cwd=repo_root, text=True, capture_output=True, check=False)
    return completed.returncode == 0 and completed.stdout.strip() == "true"


def _git_changed_paths(repo_root: Path) -> set[str]:
    paths: set[str] = set()
    for command in (["git", "diff", "--name-only"], ["git", "diff", "--name-only", "--cached"], ["git", "ls-files", "--others", "--exclude-standard"]):
        completed = subprocess.run(command, cwd=repo_root, text=True, capture_output=True, check=False)
        if completed.returncode == 0:
            paths.update(_normalize_path_token(line) for line in completed.stdout.splitlines() if _normalize_path_token(line))
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
    result = validate_scope_diff(repo_root=repo_root, run_id="manual", change_set_id=args.change_set, work_item_id=args.work_item, before=json.loads(Path(args.before).read_text(encoding="utf-8")), after=json.loads(Path(args.after).read_text(encoding="utf-8")), report_path=Path(args.report), context_metadata={"change_set_path": f"docs/changes/active/{args.change_set}.md", "active_work_item_id": args.work_item, "active_plan_path": f"docs/plans/active/{args.work_item}/plan.md"})
    print(result.message or f"scope diff {result.status}: {result.report_path}")
    return 1 if result.blocked_files else 0


if __name__ == "__main__":
    raise SystemExit(main())
