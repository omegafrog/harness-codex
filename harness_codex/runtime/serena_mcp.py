"""Conditional Serena MCP setup for Codex agent runs."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class SerenaMcpInstallation:
    """Result of detecting and preparing Serena MCP for a project."""

    enabled: bool
    language_ids: tuple[str, ...] = ()
    matched_paths: tuple[Path, ...] = ()
    command_path: str | None = None
    install_attempted: bool = False
    install_succeeded: bool = False
    install_error: str | None = None
    codex_config_overrides: tuple[str, ...] = ()

    def as_metadata(self) -> dict[str, Any]:
        """Return JSON-safe runtime metadata."""

        return {
            "enabled": self.enabled,
            "language_ids": list(self.language_ids),
            "matched_paths": [str(path) for path in self.matched_paths],
            "command_path": self.command_path,
            "install_attempted": self.install_attempted,
            "install_succeeded": self.install_succeeded,
            "install_error": self.install_error,
            "codex_config_overrides": list(self.codex_config_overrides),
        }


SUPPORTED_SUFFIXES = {
    ".py": "python",
    ".pyw": "python",
    ".js": "typescript",
    ".jsx": "typescript",
    ".mjs": "typescript",
    ".cjs": "typescript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".go": "go",
    ".rs": "rust",
    ".c": "cpp",
    ".cc": "cpp",
    ".cpp": "cpp",
    ".cxx": "cpp",
    ".h": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".scala": "scala",
    ".sh": "bash",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".json": "json",
    ".html": "html",
    ".htm": "html",
    ".css": "scss",
    ".scss": "scss",
    ".sass": "scss",
    ".md": "markdown",
    ".vue": "vue",
    ".svelte": "svelte",
    ".dart": "dart",
    ".lua": "lua",
    ".ex": "elixir",
    ".exs": "elixir",
    ".erl": "erlang",
    ".hrl": "erlang",
    ".hs": "haskell",
    ".ml": "ocaml",
    ".mli": "ocaml",
    ".lean": "lean",
    ".nix": "nix",
    ".sol": "solidity",
    ".zig": "zig",
}

MARKER_FILES = {
    "pyproject.toml": "python",
    "requirements.txt": "python",
    "setup.py": "python",
    "package.json": "typescript",
    "tsconfig.json": "typescript",
    "jsconfig.json": "typescript",
    "go.mod": "go",
    "cargo.toml": "rust",
    "pom.xml": "java",
    "build.gradle": "java",
    "build.gradle.kts": "kotlin",
    "settings.gradle": "java",
    "settings.gradle.kts": "kotlin",
    "compile_commands.json": "cpp",
    "composer.json": "php",
    "gemfile": "ruby",
    "mix.exs": "elixir",
    "package.swift": "swift",
    "flake.nix": "nix",
}

SKIPPED_DIR_NAMES = {
    ".git",
    ".harness",
    ".codex",
    ".venv",
    "venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "build",
    "dist",
    "target",
    ".gradle",
    ".idea",
    ".vscode",
}

MAX_SCAN_FILES = 5_000
INSTALL_TIMEOUT_SEC = 180


def ensure_serena_mcp(
    repo_root: Path,
    workdir: Path,
    log_dir: Path,
) -> SerenaMcpInstallation:
    """Install Serena when useful and return Codex MCP config overrides.

    Missing optional prerequisites do not block the agent run. The failure is
    recorded in metadata and Codex is invoked without Serena MCP.
    """

    language_ids, matched_paths = detect_supported_languages(repo_root, workdir)
    if not language_ids:
        return SerenaMcpInstallation(enabled=False)

    serena_path = shutil.which("serena")
    install_attempted = False
    install_succeeded = False
    install_error: str | None = None

    if serena_path is None:
        uv_path = shutil.which("uv")
        if uv_path is None:
            install_error = "uv binary not found; cannot install serena-agent"
        else:
            install_attempted = True
            completed = subprocess.run(
                [
                    uv_path,
                    "tool",
                    "install",
                    "-p",
                    "3.13",
                    "serena-agent@latest",
                    "--prerelease=allow",
                ],
                cwd=workdir,
                text=True,
                capture_output=True,
                timeout=INSTALL_TIMEOUT_SEC,
                check=False,
            )
            _write_install_logs(log_dir, completed.stdout, completed.stderr)
            install_succeeded = completed.returncode == 0
            if install_succeeded:
                serena_path = shutil.which("serena")
                if serena_path is None:
                    install_error = "serena command is not on PATH after installation"
            else:
                install_error = completed.stderr.strip() or completed.stdout.strip()

    if serena_path is None:
        return SerenaMcpInstallation(
            enabled=False,
            language_ids=language_ids,
            matched_paths=matched_paths,
            install_attempted=install_attempted,
            install_succeeded=install_succeeded,
            install_error=install_error,
        )

    return SerenaMcpInstallation(
        enabled=True,
        language_ids=language_ids,
        matched_paths=matched_paths,
        command_path=serena_path,
        install_attempted=install_attempted,
        install_succeeded=install_succeeded,
        install_error=install_error,
        codex_config_overrides=_codex_config_overrides(serena_path, workdir),
    )


def detect_supported_languages(
    repo_root: Path,
    workdir: Path,
) -> tuple[tuple[str, ...], tuple[Path, ...]]:
    """Detect Serena-supported language IDs and representative paths."""

    scan_root = workdir if workdir.exists() else repo_root
    matches: dict[str, Path] = {}
    count = 0
    for path in scan_root.rglob("*"):
        if _is_skipped_path(path, scan_root) or not path.is_file():
            continue
        count += 1
        if count > MAX_SCAN_FILES:
            break
        language_id = _language_for_path(path)
        if language_id is not None and language_id not in matches:
            matches[language_id] = _safe_relative(path, repo_root)

    language_ids = tuple(sorted(matches))
    return language_ids, tuple(matches[language_id] for language_id in language_ids)


def _is_skipped_path(path: Path, root: Path) -> bool:
    try:
        parts = path.relative_to(root).parts
    except ValueError:
        parts = path.parts
    return any(part in SKIPPED_DIR_NAMES for part in parts[:-1])


def _language_for_path(path: Path) -> str | None:
    marker_language = MARKER_FILES.get(path.name.lower())
    if marker_language is not None:
        return marker_language
    return SUPPORTED_SUFFIXES.get(path.suffix) or SUPPORTED_SUFFIXES.get(path.suffix.lower())


def _codex_config_overrides(command_path: str, workdir: Path) -> tuple[str, ...]:
    return (
        _toml_assignment("mcp_servers.serena.startup_timeout_sec", 15),
        _toml_assignment("mcp_servers.serena.command", command_path),
        _toml_assignment(
            "mcp_servers.serena.args",
            ["start-mcp-server", "--project-from-cwd", "--context=codex"],
        ),
        _toml_assignment("mcp_servers.serena.cwd", str(workdir)),
        _toml_assignment("mcp_servers.serena.enabled", True),
    )


def _toml_assignment(key: str, value: object) -> str:
    return f"{key}={_toml_value(value)}"


def _toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (tuple, list)):
        return "[" + ", ".join(_toml_value(item) for item in value) + "]"
    return json.dumps(str(value))


def _safe_relative(path: Path, root: Path) -> Path:
    try:
        return path.relative_to(root)
    except ValueError:
        return path


def _write_install_logs(log_dir: Path, stdout: str, stderr: str) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "serena-mcp-install-stdout.txt").write_text(stdout, encoding="utf-8")
    (log_dir / "serena-mcp-install-stderr.txt").write_text(stderr, encoding="utf-8")
