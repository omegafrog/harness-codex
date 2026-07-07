from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.runner import (
    AgentRunRequest,
    _agent_tmux_enabled,
    _agent_tmux_session_name,
    _run_agent_provider_process,
)


def _request(tmp_path: Path, *, tmux: bool | None = None) -> AgentRunRequest:
    config = {"provider": "codex"}
    if tmux is not None:
        config["tmux"] = tmux
    return AgentRunRequest(
        step=Step(
            id="plan work/item",
            kind=StepKind.AGENT,
            name="계획 작성",
            agent_id="implementation_planner",
            timeout_sec=5,
        ),
        context=RunContext(
            run_id="run/with spaces",
            workflow_name="test",
            mode=RunMode.APPLY,
            repo_root=tmp_path,
            workdir=tmp_path,
            run_dir=tmp_path / ".harness/runs/test",
        ),
        step_dir=tmp_path / ".harness/runs/test/steps/plan-work-item",
        agent_config_path=tmp_path / ".codex/agents/implementation_planner.toml",
        agent_config=config,
    )


def test_agent_tmux_session_name_is_attach_safe(tmp_path: Path) -> None:
    request = _request(tmp_path)

    assert _agent_tmux_session_name(request) == "harness-run-with-spaces-plan-work-item"


def test_agent_tmux_can_be_enabled_by_env_or_agent_config(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("HARNESS_AGENT_TMUX", raising=False)
    assert not _agent_tmux_enabled(_request(tmp_path))

    monkeypatch.setenv("HARNESS_AGENT_TMUX", "1")
    assert _agent_tmux_enabled(_request(tmp_path))

    assert _agent_tmux_enabled(_request(tmp_path, tmux=True))
    assert not _agent_tmux_enabled(_request(tmp_path, tmux=False))


def test_agent_provider_process_uses_tmux_when_enabled(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.delenv("TMUX", raising=False)
    request = _request(tmp_path, tmux=True)
    request.step_dir.mkdir(parents=True)
    stdout_path = request.step_dir / "stdout.txt"
    stderr_path = request.step_dir / "stderr.txt"
    metadata: dict[str, object] = {}
    calls: list[list[str]] = []

    monkeypatch.setattr("harness_codex.runtime.runner.shutil.which", lambda name: "/usr/bin/tmux")

    def fake_run(command, **kwargs):
        calls.append(list(command))
        if command[:2] == ["tmux", "new-session"]:
            (request.step_dir / "tmux-exit-code.txt").write_text("0\n", encoding="utf-8")
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr("harness_codex.runtime.runner.subprocess.run", fake_run)

    completed = _run_agent_provider_process(
        request=request,
        command=["codex", "exec", "-"],
        prompt="테스트 프롬프트",
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        provider_metadata=metadata,
    )

    assert completed.returncode == 0
    assert metadata["tmux_session"] == "harness-run-with-spaces-plan-work-item"
    assert metadata["tmux_mode"] == "session"
    assert metadata["tmux_attach_command"] == (
        "tmux attach-session -t harness-run-with-spaces-plan-work-item"
    )
    assert any(call[:2] == ["tmux", "new-session"] for call in calls)
    script = (request.step_dir / "tmux-run.sh").read_text(encoding="utf-8")
    assert "codex exec -" in script
    assert "tmux-stdin.txt" in script
    assert "stdout.txt" in script
    assert "stderr.txt" in script


def test_agent_provider_process_opens_tmux_pane_when_already_inside_tmux(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("TMUX", "/tmp/tmux-test")
    request = _request(tmp_path, tmux=True)
    request.step_dir.mkdir(parents=True)
    stdout_path = request.step_dir / "stdout.txt"
    stderr_path = request.step_dir / "stderr.txt"
    metadata: dict[str, object] = {}
    calls: list[list[str]] = []

    monkeypatch.setattr("harness_codex.runtime.runner.shutil.which", lambda name: "/usr/bin/tmux")

    def fake_run(command, **kwargs):
        calls.append(list(command))
        if command[:2] == ["tmux", "split-window"]:
            (request.step_dir / "tmux-exit-code.txt").write_text("0\n", encoding="utf-8")
            return type("Completed", (), {"returncode": 0, "stdout": "%7\n", "stderr": ""})()
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    monkeypatch.setattr("harness_codex.runtime.runner.subprocess.run", fake_run)

    completed = _run_agent_provider_process(
        request=request,
        command=["codex", "exec", "-"],
        prompt="테스트 프롬프트",
        stdout_path=stdout_path,
        stderr_path=stderr_path,
        provider_metadata=metadata,
    )

    assert completed.returncode == 0
    assert metadata["tmux_mode"] == "pane"
    assert metadata["tmux_pane"] == "%7"
    assert metadata["tmux_attach_command"] == "already attached in a new tmux pane"
    assert any(call[:2] == ["tmux", "split-window"] for call in calls)
    assert not any(call[:2] == ["tmux", "new-session"] for call in calls)
