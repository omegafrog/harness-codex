"""Conditional Playwright MCP setup for end-user E2E agent runs."""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any


INSTALL_TIMEOUT_SEC = 120


@dataclass(frozen=True)
class PlaywrightMcpInstallation:
    """Result of preparing Playwright MCP before an executor run."""

    enabled: bool
    command_path: str | None = None
    install_attempted: bool = False
    install_succeeded: bool = False
    install_error: str | None = None
    codex_config_overrides: tuple[str, ...] = ()

    def as_metadata(self) -> dict[str, Any]:
        """Return JSON-safe runtime metadata."""

        return {
            "enabled": self.enabled,
            "command_path": self.command_path,
            "install_attempted": self.install_attempted,
            "install_succeeded": self.install_succeeded,
            "install_error": self.install_error,
            "codex_config_overrides": list(self.codex_config_overrides),
        }


def ensure_playwright_mcp(workdir: Path, log_dir: Path) -> PlaywrightMcpInstallation:
    """Download and validate Playwright MCP before browser-driven E2E work."""

    npx_path = _resolve_npx_path()
    if npx_path is None:
        return PlaywrightMcpInstallation(
            enabled=False,
            install_error="Linux-native npx binary not found; cannot prepare @playwright/mcp@latest",
        )

    try:
        completed = subprocess.run(
            [npx_path, "--yes", "@playwright/mcp@latest", "--version"],
            cwd=workdir,
            text=True,
            capture_output=True,
            timeout=INSTALL_TIMEOUT_SEC,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return PlaywrightMcpInstallation(
            enabled=False,
            command_path=npx_path,
            install_attempted=True,
            install_succeeded=False,
            install_error=str(exc),
        )
    _write_install_logs(log_dir, completed.stdout, completed.stderr)
    if completed.returncode != 0:
        return PlaywrightMcpInstallation(
            enabled=False,
            command_path=npx_path,
            install_attempted=True,
            install_succeeded=False,
            install_error=completed.stderr.strip() or completed.stdout.strip(),
        )

    return PlaywrightMcpInstallation(
        enabled=True,
        command_path=npx_path,
        install_attempted=True,
        install_succeeded=True,
        codex_config_overrides=_codex_config_overrides(npx_path, workdir),
    )


def _resolve_npx_path() -> str | None:
    npx_path = shutil.which("npx")
    if npx_path is not None and not npx_path.startswith("/mnt/"):
        return npx_path

    node_path = shutil.which("node")
    if node_path is None:
        return None
    linux_npx = Path(node_path).resolve().parent / "npx"
    if linux_npx.exists():
        return str(linux_npx)
    return None


def _codex_config_overrides(command_path: str, workdir: Path) -> tuple[str, ...]:
    return (
        _toml_assignment("mcp_servers.playwright.startup_timeout_sec", 30),
        _toml_assignment("mcp_servers.playwright.command", command_path),
        _toml_assignment(
            "mcp_servers.playwright.args",
            ["--yes", "@playwright/mcp@latest", "--headless"],
        ),
        _toml_assignment("mcp_servers.playwright.cwd", str(workdir)),
        _toml_assignment("mcp_servers.playwright.enabled", True),
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


def _write_install_logs(log_dir: Path, stdout: str, stderr: str) -> None:
    log_dir.mkdir(parents=True, exist_ok=True)
    (log_dir / "playwright-mcp-install-stdout.txt").write_text(stdout, encoding="utf-8")
    (log_dir / "playwright-mcp-install-stderr.txt").write_text(stderr, encoding="utf-8")
