import json
from pathlib import Path

from harness_codex.runtime import runner, serena_mcp
from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.runner import AgentRunRequest


def _request(repo_root: Path, *, provider: str = "codex") -> AgentRunRequest:
    return AgentRunRequest(
        step=Step(
            id="agent-step",
            kind=StepKind.AGENT,
            name="Agent step",
            agent_id="agent",
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
