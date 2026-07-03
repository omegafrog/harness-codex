"""Top-level ownership boundary for implementation workflow writes."""

from __future__ import annotations

from enum import Enum
from pathlib import Path
from typing import Any, Mapping


class ArtifactBoundary(str, Enum):
    PROJECT_IMPLEMENTATION = "project_implementation"
    PROJECT_OUTPUT = "project_output"
    HARNESS_CONTROL = "harness_control"
    HARNESS_RUNTIME_OUTPUT = "harness_runtime_output"
    READ_ONLY_CONTEXT = "read_only_context"


_HARNESS_CONTROL_DIRS = {
    ".harness-codex",
    "harness_codex",
    ".codex",
    ".semgrep",
}
_HARNESS_RUNTIME_DIRS = {
    ".harness",
}
_PROJECT_OUTPUT_DIRS = {
    ".gradle",
    "build",
    "target",
    ".pytest_cache",
}
_HARNESS_CONTROL_ROOT_FILES = {
    "harness",
}
_HARNESS_CONTROL_ROOT_SCRIPTS = {
    "scripts/install-harness-codex.sh",
    "scripts/bump_runtime_version.py",
}
_PROJECT_BUILD_FILES = {
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
    "docker-compose.yml",
}


def classify_artifact_path(path: str | Path) -> ArtifactBoundary:
    normalized = _normalize(path)
    if not normalized:
        return ArtifactBoundary.PROJECT_IMPLEMENTATION
    parts = tuple(part for part in normalized.split("/") if part)
    if not parts:
        return ArtifactBoundary.PROJECT_IMPLEMENTATION
    name = parts[-1]
    top = parts[0]

    if name == "AGENTS.md":
        return ArtifactBoundary.READ_ONLY_CONTEXT
    if normalized in _HARNESS_CONTROL_ROOT_FILES or normalized in _HARNESS_CONTROL_ROOT_SCRIPTS:
        return ArtifactBoundary.HARNESS_CONTROL
    if top in _HARNESS_CONTROL_DIRS:
        return ArtifactBoundary.HARNESS_CONTROL
    if top in _HARNESS_RUNTIME_DIRS:
        return ArtifactBoundary.HARNESS_RUNTIME_OUTPUT
    if top in _PROJECT_OUTPUT_DIRS or any(part in {"build", "target", "__pycache__"} for part in parts):
        return ArtifactBoundary.PROJECT_OUTPUT
    return ArtifactBoundary.PROJECT_IMPLEMENTATION


def is_control_plane_path(path: str | Path) -> bool:
    return classify_artifact_path(path) == ArtifactBoundary.HARNESS_CONTROL


def is_runtime_output_path(path: str | Path) -> bool:
    return classify_artifact_path(path) == ArtifactBoundary.HARNESS_RUNTIME_OUTPUT


def is_read_only_context_path(path: str | Path) -> bool:
    return classify_artifact_path(path) == ArtifactBoundary.READ_ONLY_CONTEXT


def is_project_output_path(path: str | Path) -> bool:
    return classify_artifact_path(path) == ArtifactBoundary.PROJECT_OUTPUT


def is_implementation_write_candidate(path: str | Path) -> bool:
    normalized = _normalize(path)
    if "/" not in normalized and Path(normalized).name not in _PROJECT_BUILD_FILES:
        return False
    return classify_artifact_path(normalized) == ArtifactBoundary.PROJECT_IMPLEMENTATION


def is_evolve_context(metadata: Mapping[str, Any] | None) -> bool:
    if not metadata:
        return False
    if metadata.get("allow_control_plane_writes") is True:
        return True
    values = (
        metadata.get("workflow_name"),
        metadata.get("command"),
        metadata.get("run_kind"),
        metadata.get("runtime_workflow_kind"),
    )
    return any(str(value).lower() == "evolve" or "evolve" in str(value).lower() for value in values if value)


def control_plane_block_patterns() -> tuple[str, ...]:
    return (
        ".harness-codex/",
        "harness_codex/",
        ".codex/",
        ".semgrep/",
        "harness",
        "scripts/install-harness-codex.sh",
        "scripts/bump_runtime_version.py",
        "tests/runtime/",
        "completions/",
        "AGENTS.md",
        "**/AGENTS.md",
    )


def runtime_output_allow_patterns() -> tuple[tuple[str, str], ...]:
    return (
        (".harness/runs/", "runtime run artifacts"),
        (".harness/cache/", "runtime prompt context cache"),
        (".harness/sessions/", "runtime session artifacts"),
        (".harness/state/", "runtime state artifacts"),
        (".harness/checkpoints/", "runtime checkpoint artifacts"),
        (".harness/logs/", "runtime app launcher logs"),
        (".harness/ui/", "runtime UI state and logs"),
        (".harness/ui-server.log", "runtime UI server log"),
        (".harness/ui-server.pid", "runtime UI server pid"),
        (".harness/contracts/", "runtime document contract artifacts"),
    )


def project_output_allow_patterns() -> tuple[tuple[str, str], ...]:
    return (
        (".serena/", "runtime/generated local tool state"),
        ("tests/runtime/__pycache__/", "runtime/generated local verification output"),
        ("tests/__pycache__/", "runtime/generated local verification output"),
        ("**/__pycache__/**", "runtime/generated local verification output"),
        (".pytest_cache/", "runtime/generated local verification output"),
        (".gradle/", "runtime/generated local verification output"),
        ("build/**", "runtime/generated local verification output"),
        ("**/build/**", "runtime/generated local verification output"),
        ("target/**", "runtime/generated local verification output"),
        ("**/target/**", "runtime/generated local verification output"),
    )


def _normalize(path: str | Path) -> str:
    return str(path).strip().strip("|,;:)").removeprefix("./")
