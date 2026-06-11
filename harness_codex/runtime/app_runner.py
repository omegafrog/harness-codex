"""Run repository-local application launcher contracts."""

from __future__ import annotations

import hashlib
import os
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import Sequence


APP_RUN_SCRIPT = Path("scripts/run-app.sh")
APP_INFRA_SCRIPT = Path("scripts/run-app-infra.sh")
APP_SERVER_SCRIPT = Path("scripts/run-app-server.sh")
APP_INFRA_CHECK_SCRIPT = Path("scripts/check-app-infra.sh")
APP_LOG_DIR = Path(".harness/logs")
DEFAULT_READINESS_TIMEOUT_SECONDS = 60
STARTUP_STABILITY_SECONDS = 1
COMPONENTS = ("infra", "server")


def app_session_names(repo_root: Path | str) -> dict[str, str]:
    root = Path(repo_root).resolve()
    repo_name = re.sub(r"[^A-Za-z0-9_-]+", "-", root.name).strip("-_") or "app"
    repo_name = repo_name[:32]
    path_hash = hashlib.sha256(str(root).encode("utf-8")).hexdigest()[:8]
    prefix = f"{repo_name}-{path_hash}"
    return {component: f"{prefix}-{component}" for component in COMPONENTS}


def run_app(repo_root: Path | str, args: Sequence[str] = ()) -> int:
    """Execute the legacy foreground launcher from the repository root."""

    root = Path(repo_root).resolve()
    script = _require_script(root, APP_RUN_SCRIPT, "app run")
    try:
        completed = subprocess.run(
            ["bash", str(script), *args],
            cwd=root,
            check=False,
        )
    except KeyboardInterrupt:
        return 130
    return completed.returncode


def start_app(
    repo_root: Path | str,
    args: Sequence[str] = (),
    *,
    timeout: int = DEFAULT_READINESS_TIMEOUT_SECONDS,
) -> str | int:
    root = Path(repo_root).resolve()
    if timeout <= 0:
        raise ValueError("app readiness timeout must be greater than zero")
    _require_tmux()
    infra_script = _require_script(root, APP_INFRA_SCRIPT, "infrastructure")
    server_script = _require_script(root, APP_SERVER_SCRIPT, "server")
    checker = root / APP_INFRA_CHECK_SCRIPT
    names = app_session_names(root)
    logs = {
        component: root / APP_LOG_DIR / f"app-{component}.log"
        for component in COMPONENTS
    }

    stop_app(root)
    for log_path in logs.values():
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text("", encoding="utf-8")

    try:
        _start_component(root, names["infra"], infra_script, logs["infra"])
        _wait_for_infrastructure(root, names["infra"], checker, timeout)
        _start_component(
            root,
            names["server"],
            server_script,
            logs["server"],
            args=args,
        )
        time.sleep(STARTUP_STABILITY_SECONDS)
        _require_running(names["infra"], "infrastructure")
        _require_running(names["server"], "server")
    except KeyboardInterrupt:
        stop_app(root)
        return 130
    except Exception:
        stop_app(root)
        raise

    return "\n".join(
        [
            "Application started in tmux:",
            f"- infra: {names['infra']} ({logs['infra']})",
            f"- server: {names['server']} ({logs['server']})",
        ]
    )


def app_status(repo_root: Path | str) -> str:
    _require_tmux()
    names = app_session_names(repo_root)
    lines = ["Application tmux status:"]
    for component in COMPONENTS:
        lines.append(f"- {component}: {_session_status(names[component])}")
    return "\n".join(lines)


def attach_app(repo_root: Path | str, component: str) -> None:
    if component not in COMPONENTS:
        raise ValueError(f"unknown app component: {component}")
    _require_tmux()
    session_name = app_session_names(repo_root)[component]
    if _session_status(session_name) == "missing":
        raise ValueError(f"app tmux session not found: {session_name}")
    action = "switch-client" if os.environ.get("TMUX") else "attach-session"
    os.execvp("tmux", ["tmux", action, "-t", session_name])


def stop_app(repo_root: Path | str) -> str:
    _require_tmux()
    names = app_session_names(repo_root)
    for session_name in names.values():
        subprocess.run(
            ["tmux", "kill-session", "-t", session_name],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    return "Application tmux sessions stopped."


def _require_tmux() -> None:
    if shutil.which("tmux") is None:
        raise ValueError(
            "tmux is required for `harness run app`; "
            "install tmux or use `harness run app --foreground`"
        )


def _require_script(root: Path, relative_path: Path, label: str) -> Path:
    script = root / relative_path
    if not script.is_file():
        raise ValueError(f"{label} script not found: {relative_path}")
    return script


def _start_component(
    root: Path,
    session_name: str,
    script: Path,
    log_path: Path,
    *,
    args: Sequence[str] = (),
) -> None:
    _run_tmux(["new-session", "-d", "-s", session_name, "-c", str(root)])
    _run_tmux(["set-option", "-t", session_name, "remain-on-exit", "on"])
    pipe_command = f"cat >> {shlex.quote(str(log_path))}"
    _run_tmux(["pipe-pane", "-t", session_name, "-o", pipe_command])
    command = shlex.join(["exec", "bash", str(script), *args])
    _run_tmux(["send-keys", "-t", session_name, "-l", command])
    _run_tmux(["send-keys", "-t", session_name, "Enter"])


def _run_tmux(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        ["tmux", *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        suffix = f": {detail}" if detail else ""
        raise ValueError(f"tmux command failed ({' '.join(args[:2])}){suffix}")
    return completed


def _wait_for_infrastructure(
    root: Path,
    session_name: str,
    checker: Path,
    timeout: int,
) -> None:
    if not checker.is_file():
        time.sleep(STARTUP_STABILITY_SECONDS)
        _require_running(session_name, "infrastructure")
        return

    deadline = time.monotonic() + timeout
    while True:
        _require_running(session_name, "infrastructure")
        completed = subprocess.run(
            ["bash", str(checker)],
            cwd=root,
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if completed.returncode == 0:
            return
        if time.monotonic() >= deadline:
            raise ValueError(
                f"infrastructure readiness check timed out after {timeout} seconds"
            )
        time.sleep(1)


def _require_running(session_name: str, label: str) -> None:
    status = _session_status(session_name)
    if status != "running":
        raise ValueError(f"{label} failed to stay running: {status}")


def _session_status(session_name: str) -> str:
    completed = subprocess.run(
        [
            "tmux",
            "list-panes",
            "-t",
            session_name,
            "-F",
            "#{pane_dead}|#{pane_dead_status}",
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        return "missing"
    pane = completed.stdout.splitlines()[0].strip() if completed.stdout else ""
    dead, _, exit_code = pane.partition("|")
    if dead == "0":
        return "running"
    if dead == "1":
        return f"exited({exit_code or 'unknown'})"
    return "missing"
