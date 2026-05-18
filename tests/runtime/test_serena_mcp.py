import json
import subprocess
from pathlib import Path

from harness_codex.runtime import serena_mcp
from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.runner import AgentRunRequest, CodexCliAgentAdapter


def context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs/run-001",
    )


def request(repo_root: Path) -> AgentRunRequest:
    return AgentRunRequest(
        step=Step(
            id="plan-work-item",
            kind=StepKind.AGENT,
            name="Create plan",
            agent_id="implementation_planner",
            timeout_sec=30,
        ),
        context=context(repo_root),
        step_dir=repo_root / ".harness/runs/run-001/steps/plan-work-item",
        agent_config_path=repo_root / ".codex/agents/implementation_planner.toml",
        agent_config={
            "name": "implementation_planner",
            "developer_instructions": "테스트 지시문",
        },
    )


def test_detect_supported_languages_from_source_files(tmp_path: Path) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src/app.py").write_text("print('hello')\n", encoding="utf-8")
    (tmp_path / "ui.tsx").write_text("export default function App() {}\n", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "node_modules/ignored.go").write_text("package ignored\n", encoding="utf-8")

    language_ids, matched_paths = serena_mcp.detect_supported_languages(tmp_path, tmp_path)

    assert language_ids == ("python", "typescript")
    assert matched_paths == (Path("src/app.py"), Path("ui.tsx"))


def test_serena_mcp_is_disabled_without_supported_language(tmp_path: Path) -> None:
    (tmp_path / "notes.txt").write_text("plain text only\n", encoding="utf-8")

    installation = serena_mcp.ensure_serena_mcp(tmp_path, tmp_path, tmp_path)

    assert installation.enabled is False
    assert installation.language_ids == ()
    assert installation.install_attempted is False


def test_serena_mcp_installs_when_supported_language_and_serena_is_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src/app.py").write_text("print('hello')\n", encoding="utf-8")
    calls: list[str] = []

    def fake_which(name: str) -> str | None:
        if name == "uv":
            return "/usr/bin/uv"
        if name == "serena" and calls:
            return "/home/user/.local/bin/serena"
        return None

    def fake_run(*args, **kwargs):
        calls.append("install")
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="installed",
            stderr="",
        )

    monkeypatch.setattr(serena_mcp.shutil, "which", fake_which)
    monkeypatch.setattr(serena_mcp.subprocess, "run", fake_run)

    installation = serena_mcp.ensure_serena_mcp(tmp_path, tmp_path, tmp_path)

    assert installation.enabled is True
    assert installation.install_attempted is True
    assert installation.install_succeeded is True
    assert installation.command_path == "/home/user/.local/bin/serena"
    assert (tmp_path / "serena-mcp-install-stdout.txt").read_text(
        encoding="utf-8"
    ) == "installed"


def test_codex_cli_agent_adapter_enables_serena_mcp_for_supported_language(
    tmp_path: Path,
    monkeypatch,
) -> None:
    (tmp_path / "app.py").write_text("print('hello')\n", encoding="utf-8")
    agent_request = request(tmp_path)
    agent_request.step_dir.mkdir(parents=True)

    monkeypatch.setattr(
        serena_mcp.shutil,
        "which",
        lambda name: "/usr/local/bin/serena" if name == "serena" else None,
    )

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="agent stdout",
            stderr="agent stderr",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = CodexCliAgentAdapter(codex_binary="codex-test").run(agent_request)

    assert result.status == StepStatus.SUCCEEDED
    command = json.loads((agent_request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert 'mcp_servers.serena.command="/usr/local/bin/serena"' in command
    assert (
        'mcp_servers.serena.args=["start-mcp-server", "--project-from-cwd", "--context=codex"]'
    ) in command
    assert f'mcp_servers.serena.cwd="{tmp_path}"' in command
    manifest = json.loads((agent_request.step_dir / "serena-mcp.json").read_text(encoding="utf-8"))
    assert manifest["enabled"] is True
    assert manifest["language_ids"] == ["python"]
