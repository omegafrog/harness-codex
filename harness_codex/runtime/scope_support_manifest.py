"""Repository-specific support-file allowlist manifest."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path
import tomllib

from harness_codex.runtime.repo_analyzer import RepoAnalysis, analyze_repository


SCOPE_SUPPORT_MANIFEST_PATH = Path(".harness/agents/scope-support.toml")
DEFAULT_REFRESH_AFTER_HOURS = 168


@dataclass(frozen=True)
class ScopeSupportManifestResult:
    path: Path
    action: str
    allow_patterns: tuple[str, ...]
    fingerprint: str
    generated_at: str
    refresh_after_hours: int


def ensure_scope_support_manifest(
    repo_root: Path | str,
    repo_description: str = "",
    *,
    refresh_if_stale: bool = True,
) -> ScopeSupportManifestResult:
    repo = Path(repo_root)
    manifest_path = repo / SCOPE_SUPPORT_MANIFEST_PATH
    analysis = analyze_repository(repo, repo_description)
    allow_patterns = _derive_allow_patterns(repo, analysis)
    fingerprint = _manifest_fingerprint(analysis, allow_patterns)
    now = datetime.now(timezone.utc)

    current = _read_manifest(manifest_path)
    stale = refresh_if_stale and _manifest_stale(current, fingerprint, now)
    desired = _render_manifest(
        analysis=analysis,
        allow_patterns=allow_patterns,
        fingerprint=fingerprint,
        generated_at=now,
        refresh_after_hours=_refresh_after_hours(current),
    )

    if current is None:
        action = _write_if_changed(manifest_path, desired)
    elif stale:
        action = _write_if_changed(manifest_path, desired)
        if action == "unchanged":
            action = "updated"
    else:
        action = "unchanged"

    effective = _read_manifest(manifest_path) or {}
    return ScopeSupportManifestResult(
        path=SCOPE_SUPPORT_MANIFEST_PATH,
        action=action,
        allow_patterns=tuple(_manifest_allow_patterns(effective) or allow_patterns),
        fingerprint=str(effective.get("repo", {}).get("fingerprint", fingerprint)),
        generated_at=str(effective.get("generated_at", now.isoformat())),
        refresh_after_hours=_refresh_after_hours(effective),
    )


def load_scope_support_patterns(repo_root: Path | str) -> tuple[str, ...]:
    result = ensure_scope_support_manifest(repo_root)
    return result.allow_patterns


def _read_manifest(path: Path) -> dict[str, object] | None:
    if not path.is_file():
        return None
    try:
        with path.open("rb") as file:
            data = tomllib.load(file)
    except (OSError, tomllib.TOMLDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _manifest_stale(
    current: dict[str, object] | None,
    expected_fingerprint: str,
    now: datetime,
) -> bool:
    if current is None:
        return True
    repo = current.get("repo")
    if not isinstance(repo, dict):
        return True
    if str(repo.get("fingerprint", "")).strip() != expected_fingerprint:
        return True
    generated_at = _parse_timestamp(current.get("generated_at"))
    if generated_at is None:
        return True
    refresh_after = timedelta(hours=_refresh_after_hours(current))
    return generated_at + refresh_after <= now


def _refresh_after_hours(current: dict[str, object] | None) -> int:
    if not isinstance(current, dict):
        return DEFAULT_REFRESH_AFTER_HOURS
    value = current.get("refresh_after_hours", DEFAULT_REFRESH_AFTER_HOURS)
    if isinstance(value, int) and value > 0:
        return value
    return DEFAULT_REFRESH_AFTER_HOURS


def _parse_timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _manifest_allow_patterns(data: dict[str, object]) -> tuple[str, ...]:
    support_files = data.get("support_files")
    if not isinstance(support_files, dict):
        return ()
    allow = support_files.get("allow")
    if not isinstance(allow, list):
        return ()
    return tuple(
        dict.fromkeys(
            item.strip()
            for item in allow
            if isinstance(item, str) and item.strip()
        )
    )


def _derive_allow_patterns(repo: Path, analysis: RepoAnalysis) -> tuple[str, ...]:
    patterns: list[str] = []
    patterns.extend(path.as_posix() for path in analysis.manifests)

    exact_candidates = (
        "gradle.properties",
        "gradlew",
        "gradlew.bat",
        "mvnw",
        "mvnw.cmd",
        "go.sum",
        "Cargo.lock",
    )
    patterns.extend(name for name in exact_candidates if (repo / name).exists())

    dir_candidates = (
        "scripts",
        "script",
        "config",
        "configs",
        "gradle",
        ".mvn",
        ".github",
        "src/main/resources",
        "src/test/resources",
    )
    patterns.extend(f"{name}/**" for name in dir_candidates if (repo / name).exists())

    patterns.extend(_top_level_support_files(repo))
    return tuple(dict.fromkeys(patterns))


def _top_level_support_files(repo: Path) -> tuple[str, ...]:
    patterns: list[str] = []
    exact_prefixes = (
        "Dockerfile",
        "compose",
        "docker-compose",
    )
    exact_suffixes = (
        ".xml",
        ".yml",
        ".yaml",
        ".properties",
        ".toml",
        ".conf",
        ".ini",
    )
    for entry in sorted(repo.iterdir(), key=lambda item: item.name):
        if not entry.is_file():
            continue
        name = entry.name
        if name in {"README.md", "AGENTS.md"}:
            continue
        if any(name.startswith(prefix) for prefix in exact_prefixes) or any(
            name.endswith(suffix) for suffix in exact_suffixes
        ):
            patterns.append(name)
    return tuple(patterns)


def _manifest_fingerprint(
    analysis: RepoAnalysis,
    allow_patterns: tuple[str, ...],
) -> str:
    payload = {
        "technologies": list(analysis.technologies),
        "manifests": [path.as_posix() for path in analysis.manifests],
        "source_roots": [path.as_posix() for path in analysis.source_roots],
        "test_roots": [path.as_posix() for path in analysis.test_roots],
        "docs_roots": [path.as_posix() for path in analysis.docs_roots],
        "config_files": [path.as_posix() for path in analysis.config_files],
        "workflow_docs": [path.as_posix() for path in analysis.workflow_docs],
        "allow_patterns": list(allow_patterns),
    }
    return hashlib.sha256(
        json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _render_manifest(
    *,
    analysis: RepoAnalysis,
    allow_patterns: tuple[str, ...],
    fingerprint: str,
    generated_at: datetime,
    refresh_after_hours: int,
) -> str:
    technologies = json.dumps(list(analysis.technologies), ensure_ascii=False)
    manifests = json.dumps(
        [path.as_posix() for path in analysis.manifests],
        ensure_ascii=False,
    )
    allow = json.dumps(list(allow_patterns), ensure_ascii=False)
    lines = [
        'version = "1"',
        f'generated_at = "{generated_at.isoformat()}"',
        f"refresh_after_hours = {refresh_after_hours}",
        "",
        "[repo]",
        f'fingerprint = "{fingerprint}"',
        f"technologies = {technologies}",
        f"manifests = {manifests}",
        "",
        "[support_files]",
        f"allow = {allow}",
        "",
    ]
    return "\n".join(lines)


def _write_if_changed(path: Path, content: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_text(encoding="utf-8") == content:
        return "unchanged"
    action = "updated" if path.exists() else "created"
    path.write_text(content, encoding="utf-8")
    return action
