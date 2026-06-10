import subprocess
from pathlib import Path

from harness_codex.runtime import playwright_mcp


def test_playwright_mcp_is_disabled_without_npx(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(playwright_mcp.shutil, "which", lambda _name: None)

    installation = playwright_mcp.ensure_playwright_mcp(tmp_path, tmp_path)

    assert installation.enabled is False
    assert installation.install_attempted is False
    assert "Linux-native npx binary not found" in (installation.install_error or "")


def test_playwright_mcp_is_prepared_and_configured_before_executor_run(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: list[list[str]] = []
    monkeypatch.setattr(
        playwright_mcp.shutil,
        "which",
        lambda name: "/home/user/.nvm/bin/npx" if name == "npx" else None,
    )

    def fake_run(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "Version 0.0.74\n", "")

    monkeypatch.setattr(playwright_mcp.subprocess, "run", fake_run)
    browser = Path("/home/user/.cache/ms-playwright/chromium/chrome")
    monkeypatch.setattr(playwright_mcp, "_resolve_cached_chromium", lambda: browser)

    installation = playwright_mcp.ensure_playwright_mcp(tmp_path, tmp_path)

    assert installation.enabled is True
    assert installation.install_attempted is True
    assert installation.install_succeeded is True
    assert calls == [["/home/user/.nvm/bin/npx", "--yes", "@playwright/mcp@latest", "--version"]]
    assert 'mcp_servers.playwright.command="/home/user/.nvm/bin/npx"' in installation.codex_config_overrides
    assert (
        'mcp_servers.playwright.args=["--yes", "@playwright/mcp@latest", "--headless", '
        '"--executable-path", "/home/user/.cache/ms-playwright/chromium/chrome"]'
        in installation.codex_config_overrides
    )
    assert installation.browser_executable_path == str(browser)
    assert (tmp_path / "playwright-mcp-install-stdout.txt").read_text(encoding="utf-8") == (
        "Version 0.0.74\n"
    )


def test_playwright_mcp_installs_user_local_chromium_when_cache_is_empty(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls: list[list[str]] = []
    browser = Path("/home/user/.cache/ms-playwright/chromium/chrome")
    resolutions = iter((None, browser))
    monkeypatch.setattr(
        playwright_mcp.shutil,
        "which",
        lambda name: "/home/user/.nvm/bin/npx" if name == "npx" else None,
    )
    monkeypatch.setattr(
        playwright_mcp,
        "_resolve_cached_chromium",
        lambda: next(resolutions),
    )

    def fake_run(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "ready\n", "")

    monkeypatch.setattr(playwright_mcp.subprocess, "run", fake_run)

    installation = playwright_mcp.ensure_playwright_mcp(tmp_path, tmp_path)

    assert installation.enabled is True
    assert calls == [
        ["/home/user/.nvm/bin/npx", "--yes", "@playwright/mcp@latest", "--version"],
        ["/home/user/.nvm/bin/npx", "--yes", "playwright@latest", "install", "chromium"],
    ]
    assert installation.browser_executable_path == str(browser)


def test_playwright_mcp_prefers_linux_npx_sibling_when_windows_npx_is_first(
    tmp_path: Path,
    monkeypatch,
) -> None:
    node_bin = tmp_path / "nvm/bin"
    node_bin.mkdir(parents=True)
    node = node_bin / "node"
    npx = node_bin / "npx"
    node.write_text("", encoding="utf-8")
    npx.write_text("", encoding="utf-8")

    monkeypatch.setattr(
        playwright_mcp.shutil,
        "which",
        lambda name: "/mnt/d/npx" if name == "npx" else str(node) if name == "node" else None,
    )

    assert playwright_mcp._resolve_npx_path() == str(npx)


def test_browser_ui_candidate_requires_plan_target_and_runnable_web_package(tmp_path: Path) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("Verify rendered UI in browser.\n", encoding="utf-8")
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text(
        '{"scripts":{"dev":"vite"},"dependencies":{"react":"latest","vite":"latest"}}',
        encoding="utf-8",
    )

    assert playwright_mcp.browser_ui_candidate(tmp_path, Path("docs/plans/active/UC-001/plan.md"))


def test_browser_ui_candidate_rejects_api_only_plan(tmp_path: Path) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("Verify REST API response.\n", encoding="utf-8")
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text(
        '{"scripts":{"dev":"vite"},"dependencies":{"react":"latest"}}',
        encoding="utf-8",
    )

    assert not playwright_mcp.browser_ui_candidate(tmp_path, Path("docs/plans/active/UC-001/plan.md"))
