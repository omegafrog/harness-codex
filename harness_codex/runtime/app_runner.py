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
APP_DEV_BUILD_IMAGES_SCRIPT = Path("scripts/app/dev/build-images.sh")
APP_DEV_START_SCRIPT = Path("scripts/app/dev/start.sh")
APP_DEV_STOP_SCRIPT = Path("scripts/app/dev/stop.sh")
APP_DEV_HEALTH_SCRIPT = Path("scripts/app/dev/health.sh")
APP_DEV_LOGS_SCRIPT = Path("scripts/app/dev/logs.sh")
APP_PROD_BUILD_IMAGES_SCRIPT = Path("scripts/app/prod/build-images.sh")
APP_PROD_START_SCRIPT = Path("scripts/app/prod/start.sh")
APP_PROD_STOP_SCRIPT = Path("scripts/app/prod/stop.sh")
APP_PROD_HEALTH_SCRIPT = Path("scripts/app/prod/health.sh")
APP_PROD_LOGS_SCRIPT = Path("scripts/app/prod/logs.sh")
APP_LOGS_SCRIPT = Path("scripts/run-app-logs.sh")
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
    if _has_lifecycle_dev_scripts(root):
        return _start_lifecycle_dev_app(root, args, timeout=timeout)
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
    root = Path(repo_root).resolve()
    if _has_lifecycle_dev_scripts(root):
        lines = ["Application runtime status:"]
        lines.append(f"- dev scripts: {_lifecycle_dev_contract_status(root)}")
        lines.append(f"- dev health: {_script_status(root, APP_DEV_HEALTH_SCRIPT)}")
        if _repo_uses_docker(root):
            lines.append(f"- docker: {_docker_status()}")
        return "\n".join(lines)
    _require_tmux()
    names = app_session_names(root)
    lines = ["Application tmux status:"]
    for component in COMPONENTS:
        lines.append(f"- {component}: {_session_status(names[component])}")
    if _repo_uses_docker(root):
        lines.append(f"- docker: {_docker_status()}")
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
    root = Path(repo_root).resolve()
    messages: list[str] = []
    if (root / APP_DEV_STOP_SCRIPT).is_file():
        _run_script(root, APP_DEV_STOP_SCRIPT)
        messages.append("Development app runtime stopped.")
    if shutil.which("tmux") is not None:
        names = app_session_names(root)
        for session_name in names.values():
            subprocess.run(
                ["tmux", "kill-session", "-t", session_name],
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        messages.append("Application tmux sessions stopped.")
    elif not messages:
        _require_tmux()
    return "\n".join(messages)


def _has_lifecycle_dev_scripts(root: Path) -> bool:
    return (root / APP_DEV_START_SCRIPT).is_file() and (root / APP_DEV_HEALTH_SCRIPT).is_file()


def _lifecycle_dev_contract_status(root: Path) -> str:
    required = (
        APP_DEV_BUILD_IMAGES_SCRIPT,
        APP_DEV_START_SCRIPT,
        APP_DEV_STOP_SCRIPT,
        APP_DEV_HEALTH_SCRIPT,
    )
    missing = [str(path) for path in required if not (root / path).is_file()]
    return "configured" if not missing else "missing " + ", ".join(missing)


def _start_lifecycle_dev_app(
    root: Path,
    args: Sequence[str],
    *,
    timeout: int,
) -> str | int:
    try:
        if (root / APP_DEV_BUILD_IMAGES_SCRIPT).is_file():
            _run_script(root, APP_DEV_BUILD_IMAGES_SCRIPT)
        _run_script(root, APP_DEV_START_SCRIPT, args=args)
        _wait_for_lifecycle_health(root, timeout)
    except KeyboardInterrupt:
        stop_app(root)
        return 130
    except Exception:
        stop_app(root)
        raise
    return "\n".join(
        [
            "Application development runtime started:",
            f"- start: {APP_DEV_START_SCRIPT}",
            f"- health: {APP_DEV_HEALTH_SCRIPT}",
        ]
    )


def _wait_for_lifecycle_health(root: Path, timeout: int) -> None:
    deadline = time.monotonic() + timeout
    while True:
        completed = _run_script(root, APP_DEV_HEALTH_SCRIPT, check=False)
        if completed.returncode == 0:
            return
        if time.monotonic() >= deadline:
            raise ValueError(
                f"development runtime health check timed out after {timeout} seconds"
            )
        time.sleep(1)


def _script_status(root: Path, script: Path) -> str:
    if not (root / script).is_file():
        return f"missing {script}"
    completed = _run_script(root, script, check=False, timeout=10)
    if completed.returncode == 0:
        return "healthy"
    detail = (completed.stderr or completed.stdout or "").strip().splitlines()
    suffix = f" ({detail[-1]})" if detail else ""
    return f"unhealthy{suffix}"


def _run_script(
    root: Path,
    script: Path,
    *,
    args: Sequence[str] = (),
    check: bool = True,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        ["bash", str(root / script), *args],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if check and completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        suffix = f": {detail}" if detail else ""
        raise ValueError(f"script failed: {script}{suffix}")
    return completed


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


def _repo_uses_docker(root: Path) -> bool:
    docker_markers = (
        "compose.yaml",
        "compose.yml",
        "docker-compose.yaml",
        "docker-compose.yml",
        "Dockerfile",
    )
    if any((root / marker).exists() for marker in docker_markers):
        return True
    for script in (
        APP_INFRA_SCRIPT,
        APP_INFRA_CHECK_SCRIPT,
        APP_SERVER_SCRIPT,
        APP_RUN_SCRIPT,
        APP_DEV_BUILD_IMAGES_SCRIPT,
        APP_DEV_START_SCRIPT,
        APP_DEV_STOP_SCRIPT,
        APP_DEV_HEALTH_SCRIPT,
        APP_DEV_LOGS_SCRIPT,
        APP_PROD_BUILD_IMAGES_SCRIPT,
        APP_PROD_START_SCRIPT,
        APP_PROD_STOP_SCRIPT,
        APP_PROD_HEALTH_SCRIPT,
        APP_PROD_LOGS_SCRIPT,
        APP_LOGS_SCRIPT,
    ):
        path = root / script
        if path.is_file() and "docker" in path.read_text(encoding="utf-8", errors="ignore"):
            return True
    return False


def _docker_status() -> str:
    if shutil.which("docker") is None:
        return "missing"
    try:
        completed = subprocess.run(
            ["docker", "info"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        return "daemon-timeout"
    if completed.returncode == 0:
        return "running"
    detail = (completed.stderr or "").strip().splitlines()
    suffix = f" ({detail[-1]})" if detail else ""
    return f"daemon-unavailable{suffix}"


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
