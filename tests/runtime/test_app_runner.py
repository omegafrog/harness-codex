import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from harness_codex.runtime import app_runner
from harness_codex.runtime.app_runner import (
    APP_INFRA_CHECK_SCRIPT,
    APP_INFRA_SCRIPT,
    APP_RUN_SCRIPT,
    APP_SERVER_SCRIPT,
    app_session_names,
    app_status,
    attach_app,
    run_app,
    start_app,
    stop_app,
)


def _write_script(root: Path, relative_path: Path, content: str = "exit 0\n") -> Path:
    script = root / relative_path
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text(f"#!/usr/bin/env bash\n{content}", encoding="utf-8")
    return script


def test_run_app_requires_versioned_script(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="app run script not found"):
        run_app(tmp_path)


def test_run_app_executes_from_repo_root_and_forwards_args(tmp_path: Path) -> None:
    script = _write_script(
        tmp_path,
        APP_RUN_SCRIPT,
        """python3 - "$@" <<'PY'
import json
import pathlib
import sys

pathlib.Path("app-run.json").write_text(
    json.dumps({"cwd": str(pathlib.Path.cwd()), "args": sys.argv[1:]}),
    encoding="utf-8",
)
PY
exit 7
""",
    )
    assert script.is_file()

    assert run_app(tmp_path, ("--profile", "local")) == 7

    result = json.loads((tmp_path / "app-run.json").read_text(encoding="utf-8"))
    assert result == {
        "cwd": str(tmp_path.resolve()),
        "args": ["--profile", "local"],
    }


def test_run_app_returns_130_when_interrupted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_script(tmp_path, APP_RUN_SCRIPT)

    def interrupt(*args, **kwargs):
        raise KeyboardInterrupt

    monkeypatch.setattr(subprocess, "run", interrupt)

    assert run_app(tmp_path) == 130


def test_session_names_are_stable_and_path_specific(tmp_path: Path) -> None:
    first = tmp_path / "one" / "same repo"
    second = tmp_path / "two" / "same repo"

    assert app_session_names(first) == app_session_names(first)
    assert app_session_names(first) != app_session_names(second)
    assert app_session_names(first)["infra"].endswith("-infra")
    assert " " not in app_session_names(first)["server"]


def test_start_app_requires_tmux(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(shutil, "which", lambda command: None)

    with pytest.raises(ValueError, match="tmux is required"):
        start_app(tmp_path)


def test_start_app_requires_component_scripts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux")

    with pytest.raises(ValueError, match="infrastructure script not found"):
        start_app(tmp_path)

    _write_script(tmp_path, APP_INFRA_SCRIPT)
    with pytest.raises(ValueError, match="server script not found"):
        start_app(tmp_path)


def test_start_app_restarts_infra_then_server_and_forwards_server_args(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    infra = _write_script(tmp_path, APP_INFRA_SCRIPT)
    server = _write_script(tmp_path, APP_SERVER_SCRIPT)
    checker = _write_script(tmp_path, APP_INFRA_CHECK_SCRIPT)
    events: list[object] = []

    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux")
    monkeypatch.setattr(
        app_runner,
        "stop_app",
        lambda root: events.append(("stop", Path(root))) or "stopped",
    )
    monkeypatch.setattr(
        app_runner,
        "_start_component",
        lambda root, name, script, log, args=(): events.append(
            ("start", script, tuple(args), log)
        ),
    )
    monkeypatch.setattr(
        app_runner,
        "_wait_for_infrastructure",
        lambda root, name, check, timeout: events.append(
            ("wait", check, timeout)
        ),
    )
    monkeypatch.setattr(
        app_runner,
        "_require_running",
        lambda name, label: events.append(("running", label)),
    )
    monkeypatch.setattr(app_runner.time, "sleep", lambda seconds: None)

    output = start_app(tmp_path, ("--profile", "local"), timeout=12)

    assert events == [
        ("stop", tmp_path.resolve()),
        ("start", infra, (), tmp_path / ".harness/logs/app-infra.log"),
        ("wait", checker, 12),
        (
            "start",
            server,
            ("--profile", "local"),
            tmp_path / ".harness/logs/app-server.log",
        ),
        ("running", "infrastructure"),
        ("running", "server"),
    ]
    assert "Application started in tmux:" in output


def test_start_app_rejects_invalid_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with pytest.raises(ValueError, match="greater than zero"):
        start_app(tmp_path, timeout=0)


def test_start_app_cleans_both_sessions_after_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_script(tmp_path, APP_INFRA_SCRIPT)
    _write_script(tmp_path, APP_SERVER_SCRIPT)
    stops: list[Path] = []

    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux")
    monkeypatch.setattr(
        app_runner,
        "stop_app",
        lambda root: stops.append(Path(root)) or "stopped",
    )
    monkeypatch.setattr(
        app_runner,
        "_start_component",
        lambda *args, **kwargs: (_ for _ in ()).throw(ValueError("start failed")),
    )

    with pytest.raises(ValueError, match="start failed"):
        start_app(tmp_path)

    assert stops == [tmp_path.resolve(), tmp_path.resolve()]


def test_start_app_rolls_back_when_server_start_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_script(tmp_path, APP_INFRA_SCRIPT)
    _write_script(tmp_path, APP_SERVER_SCRIPT)
    starts = iter((None, ValueError("server failed")))
    stops: list[Path] = []

    def fake_start(*args, **kwargs) -> None:
        result = next(starts)
        if isinstance(result, Exception):
            raise result

    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux")
    monkeypatch.setattr(
        app_runner,
        "stop_app",
        lambda root: stops.append(Path(root)) or "stopped",
    )
    monkeypatch.setattr(
        app_runner,
        "_start_component",
        fake_start,
    )
    monkeypatch.setattr(
        app_runner,
        "_wait_for_infrastructure",
        lambda *args, **kwargs: None,
    )

    with pytest.raises(ValueError, match="server failed"):
        start_app(tmp_path)

    assert stops == [tmp_path.resolve(), tmp_path.resolve()]


def test_start_component_configures_cwd_logging_and_remain_on_exit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    script = _write_script(tmp_path, APP_SERVER_SCRIPT)
    commands: list[list[str]] = []
    monkeypatch.setattr(
        app_runner,
        "_run_tmux",
        lambda args: commands.append(list(args)),
    )

    app_runner._start_component(
        tmp_path,
        "repo-server",
        script,
        tmp_path / ".harness/logs/app-server.log",
        args=("--profile", "local"),
    )

    assert commands[0] == [
        "new-session",
        "-d",
        "-s",
        "repo-server",
        "-c",
        str(tmp_path),
    ]
    assert commands[1] == [
        "set-option",
        "-t",
        "repo-server",
        "remain-on-exit",
        "on",
    ]
    assert commands[2][0:3] == ["pipe-pane", "-t", "repo-server"]
    assert "app-server.log" in commands[2][4]
    assert commands[3][0:4] == ["send-keys", "-t", "repo-server", "-l"]
    assert str(script) in commands[3][4]
    assert "--profile local" in commands[3][4]
    assert commands[4] == ["send-keys", "-t", "repo-server", "Enter"]


def test_wait_for_infrastructure_without_checker_requires_live_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checked: list[tuple[str, str]] = []
    monkeypatch.setattr(app_runner.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        app_runner,
        "_require_running",
        lambda name, label: checked.append((name, label)),
    )

    app_runner._wait_for_infrastructure(
        tmp_path,
        "repo-infra",
        tmp_path / APP_INFRA_CHECK_SCRIPT,
        60,
    )

    assert checked == [("repo-infra", "infrastructure")]


def test_require_running_rejects_exited_infrastructure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        app_runner,
        "_session_status",
        lambda name: "exited(3)",
    )

    with pytest.raises(ValueError, match=r"infrastructure.*exited\(3\)"):
        app_runner._require_running("repo-infra", "infrastructure")


def test_wait_for_infrastructure_polls_until_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checker = _write_script(tmp_path, APP_INFRA_CHECK_SCRIPT)
    results = iter((1, 1, 0))
    checks: list[str] = []

    monkeypatch.setattr(
        app_runner,
        "_require_running",
        lambda name, label: checks.append(name),
    )
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0], next(results)
        ),
    )
    monkeypatch.setattr(app_runner.time, "monotonic", lambda: 0)
    monkeypatch.setattr(app_runner.time, "sleep", lambda seconds: None)

    app_runner._wait_for_infrastructure(tmp_path, "repo-infra", checker, 60)

    assert checks == ["repo-infra", "repo-infra", "repo-infra"]


def test_wait_for_infrastructure_times_out(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    checker = _write_script(tmp_path, APP_INFRA_CHECK_SCRIPT)
    clock = iter((0, 0, 2))

    monkeypatch.setattr(app_runner, "_require_running", lambda *args: None)
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(args[0], 1),
    )
    monkeypatch.setattr(app_runner.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(app_runner.time, "sleep", lambda seconds: None)

    with pytest.raises(ValueError, match="timed out after 1 seconds"):
        app_runner._wait_for_infrastructure(tmp_path, "repo-infra", checker, 1)


@pytest.mark.parametrize(
    ("pane_output", "returncode", "expected"),
    [
        ("0|\n", 0, "running"),
        ("1|7\n", 0, "exited(7)"),
        ("", 1, "missing"),
    ],
)
def test_session_status(
    pane_output: str,
    returncode: int,
    expected: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args[0],
            returncode,
            stdout=pane_output,
            stderr="",
        ),
    )

    assert app_runner._session_status("repo-infra") == expected


def test_status_reports_each_component(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux")
    statuses = iter(("running", "exited(9)"))
    monkeypatch.setattr(app_runner, "_session_status", lambda name: next(statuses))

    assert app_status(tmp_path).splitlines() == [
        "Application tmux status:",
        "- infra: running",
        "- server: exited(9)",
    ]


def test_status_reports_missing_docker_when_repo_uses_docker(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_script(tmp_path, APP_INFRA_SCRIPT, "docker compose up\n")
    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux" if command == "tmux" else None)
    statuses = iter(("missing", "missing"))
    monkeypatch.setattr(app_runner, "_session_status", lambda name: next(statuses))

    assert app_status(tmp_path).splitlines() == [
        "Application tmux status:",
        "- infra: missing",
        "- server: missing",
        "- docker: missing",
    ]


def test_status_reports_unavailable_docker_daemon(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "compose.yaml").write_text("services: {}\n", encoding="utf-8")
    monkeypatch.setattr(shutil, "which", lambda command: f"/usr/bin/{command}")
    statuses = iter(("missing", "missing"))
    monkeypatch.setattr(app_runner, "_session_status", lambda name: next(statuses))

    def fake_run(command, **kwargs):
        if command == ["docker", "info"]:
            return subprocess.CompletedProcess(command, 1, stderr="Cannot connect to Docker daemon\n")
        raise AssertionError(command)

    monkeypatch.setattr(subprocess, "run", fake_run)

    assert "- docker: daemon-unavailable (Cannot connect to Docker daemon)" in app_status(tmp_path)


def test_stop_kills_both_sessions_and_is_idempotent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    commands: list[list[str]] = []
    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda command, **kwargs: commands.append(command)
        or subprocess.CompletedProcess(command, 1),
    )

    assert stop_app(tmp_path) == "Application tmux sessions stopped."
    assert [command[1] for command in commands] == ["kill-session", "kill-session"]
    assert {command[-1].rsplit("-", 1)[-1] for command in commands} == {
        "infra",
        "server",
    }


def test_attach_replaces_process_for_live_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux")
    monkeypatch.setattr(app_runner, "_session_status", lambda name: "running")
    monkeypatch.delenv("TMUX", raising=False)
    monkeypatch.setattr(
        os,
        "execvp",
        lambda executable, args: calls.append((executable, args)),
    )

    attach_app(tmp_path, "infra")

    assert calls[0][0] == "tmux"
    assert calls[0][1][0:3] == ["tmux", "attach-session", "-t"]


def test_attach_switches_client_inside_tmux(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[str, list[str]]] = []
    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux")
    monkeypatch.setattr(app_runner, "_session_status", lambda name: "running")
    monkeypatch.setenv("TMUX", "/tmp/tmux-1000/default,1,0")
    monkeypatch.setattr(
        os,
        "execvp",
        lambda executable, args: calls.append((executable, args)),
    )

    attach_app(tmp_path, "server")

    assert calls[0][0] == "tmux"
    assert calls[0][1][0:3] == ["tmux", "switch-client", "-t"]


def test_attach_rejects_missing_or_unknown_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(shutil, "which", lambda command: "/usr/bin/tmux")
    monkeypatch.setattr(app_runner, "_session_status", lambda name: "missing")

    with pytest.raises(ValueError, match="session not found"):
        attach_app(tmp_path, "server")
    with pytest.raises(ValueError, match="unknown app component"):
        attach_app(tmp_path, "worker")


@pytest.mark.skipif(shutil.which("tmux") is None, reason="tmux is not installed")
def test_real_tmux_lifecycle_smoke(tmp_path: Path) -> None:
    _write_script(
        tmp_path,
        APP_INFRA_SCRIPT,
        'echo infra-ready\ntrap "exit 0" INT TERM\nwhile true; do sleep 1; done\n',
    )
    _write_script(
        tmp_path,
        APP_SERVER_SCRIPT,
        'echo server-ready\ntrap "exit 0" INT TERM\nwhile true; do sleep 1; done\n',
    )
    _write_script(tmp_path, APP_INFRA_CHECK_SCRIPT)

    try:
        output = start_app(tmp_path, timeout=5)
        assert "Application started in tmux:" in output
        assert "- infra: running" in app_status(tmp_path)
        assert "- server: running" in app_status(tmp_path)
    finally:
        stop_app(tmp_path)
