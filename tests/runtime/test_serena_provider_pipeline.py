import json
from pathlib import Path

from harness_codex.runtime import playwright_mcp, runner, serena_mcp
from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.runner import AgentRunRequest


def _request(
    repo_root: Path,
    *,
    provider: str = "codex",
    agent_id: str = "agent",
) -> AgentRunRequest:
    return AgentRunRequest(
        step=Step(
            id="agent-step",
            kind=StepKind.AGENT,
            name="Agent step",
            agent_id=agent_id,
            timeout_sec=30,
        ),
        context=RunContext(
            run_id="run-serena",
            workflow_name="workflow",
            mode=RunMode.APPLY,
            repo_root=repo_root,
            workdir=repo_root,
            run_dir=repo_root / ".harness/runs/run-serena",
        ),
        step_dir=repo_root / ".harness/runs/run-serena/steps/agent-step",
        agent_config_path=repo_root / ".codex/agents/agent.toml",
        agent_config={
            "name": "agent",
            "provider": provider,
            "provider_command": ["custom-agent"],
        },
    )


def test_codex_provider_command_injects_serena_mcp(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / "app.py").write_text("print('hello')\n", encoding="utf-8")
    request = _request(tmp_path)
    request.step_dir.mkdir(parents=True)

    monkeypatch.setattr(
        serena_mcp.shutil,
        "which",
        lambda name: "/usr/local/bin/serena" if name == "serena" else None,
    )

    command, metadata = runner._resolve_provider_command(
        request,
        request.step_dir / "final-message.md",
        default_codex_binary="codex-test",
    )

    assert command[0] == "codex-test"
    assert command[-1] == "-"
    assert 'mcp_servers.serena.command="/usr/local/bin/serena"' in command
    assert 'mcp_servers.serena.enabled=true' in command
    assert metadata["provider"] == "codex"
    assert metadata["provider_command"] == command
    assert metadata["serena_mcp"]["enabled"] is True
    manifest = json.loads((request.step_dir / "serena-mcp.json").read_text(encoding="utf-8"))
    assert manifest["enabled"] is True


def test_custom_cli_provider_does_not_inject_serena_mcp(tmp_path: Path, monkeypatch) -> None:
    request = _request(tmp_path, provider="custom_cli")
    request.step_dir.mkdir(parents=True)

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("custom_cli must not call ensure_serena_mcp")

    monkeypatch.setattr("harness_codex.runtime.serena_patch.ensure_serena_mcp", fail_if_called)

    command, metadata = runner._resolve_provider_command(
        request,
        request.step_dir / "final-message.md",
        default_codex_binary="codex-test",
    )

    assert command == ["custom-agent"]
    assert metadata["provider"] == "custom_cli"
    assert "serena_mcp" not in metadata
    assert not (request.step_dir / "serena-mcp.json").exists()


def test_executor_codex_provider_prepares_and_injects_playwright_mcp(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = _request(tmp_path, agent_id="implementation_executor")
    request.step_dir.mkdir(parents=True)
    plan_path = tmp_path / request.context.active_plan_path
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text("Verify browser rendered UI through frontend.\n", encoding="utf-8")
    frontend = tmp_path / "frontend"
    frontend.mkdir()
    (frontend / "package.json").write_text(
        '{"scripts":{"dev":"vite"},"dependencies":{"react":"latest"}}',
        encoding="utf-8",
    )
    monkeypatch.setattr(
        playwright_mcp.shutil,
        "which",
        lambda name: "/home/user/.nvm/bin/npx" if name == "npx" else None,
    )
    monkeypatch.setattr(
        playwright_mcp.subprocess,
        "run",
        lambda command, **_kwargs: __import__("subprocess").CompletedProcess(
            command, 0, "ready\n", ""
        ),
    )
    monkeypatch.setattr(
        playwright_mcp,
        "_resolve_cached_chromium",
        lambda: Path("/home/user/.cache/ms-playwright/chromium/chrome"),
    )

    command, metadata = runner._resolve_provider_command(
        request,
        request.step_dir / "final-message.md",
        default_codex_binary="codex-test",
    )

    assert 'mcp_servers.playwright.command="/home/user/.nvm/bin/npx"' in command
    assert (
        'mcp_servers.playwright.args=["--yes", "@playwright/mcp@latest", '
        '"--headless", "--executable-path", '
        '"/home/user/.cache/ms-playwright/chromium/chrome"]'
    ) in command
    assert 'mcp_servers.playwright.enabled=true' in command
    assert metadata["playwright_mcp"]["enabled"] is True
    assert metadata["playwright_mcp"]["browser_executable_path"].endswith(
        "chromium/chrome"
    )
    manifest = json.loads((request.step_dir / "playwright-mcp.json").read_text(encoding="utf-8"))
    assert manifest["install_succeeded"] is True


def test_executor_codex_provider_keeps_api_only_flow_without_playwright_mcp(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = _request(tmp_path, agent_id="implementation_executor")
    request.step_dir.mkdir(parents=True)
    plan_path = tmp_path / request.context.active_plan_path
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text("Verify REST API behavior.\n", encoding="utf-8")

    def fail_if_called(*_args, **_kwargs):
        raise AssertionError("API-only executor must not prepare Playwright MCP")

    monkeypatch.setattr("harness_codex.runtime.serena_patch.ensure_playwright_mcp", fail_if_called)

    command, metadata = runner._resolve_provider_command(
        request,
        request.step_dir / "final-message.md",
        default_codex_binary="codex-test",
    )

    assert not any("mcp_servers.playwright" in argument for argument in command)
    assert metadata["playwright_mcp"]["enabled"] is False
    assert "no browser-eligible web UI" in metadata["playwright_mcp"]["reason"]
    assert not (request.step_dir / "playwright-mcp.json").exists()
