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
APP_DEV_DEPLOY_SCRIPT = Path("scripts/app/dev/deploy.sh")
APP_DEV_START_SCRIPT = Path("scripts/app/dev/start.sh")
APP_DEV_STOP_SCRIPT = Path("scripts/app/dev/stop.sh")
APP_DEV_HEALTH_SCRIPT = Path("scripts/app/dev/health.sh")
APP_DEV_LOGS_SCRIPT = Path("scripts/app/dev/logs.sh")
APP_PROD_BUILD_IMAGES_SCRIPT = Path("scripts/app/prod/build-images.sh")
APP_PROD_DEPLOY_SCRIPT = Path("scripts/app/prod/deploy.sh")
APP_PROD_START_SCRIPT = Path("scripts/app/prod/start.sh")
APP_PROD_STOP_SCRIPT = Path("scripts/app/prod/stop.sh")
APP_PROD_HEALTH_SCRIPT = Path("scripts/app/prod/health.sh")
APP_PROD_LOGS_SCRIPT = Path("scripts/app/prod/logs.sh")
APP_LOGS_SCRIPT = Path("scripts/run-app-logs.sh")
APP_LOG_DIR = Path(".harness/logs")
APP_ENV_DIR = Path(".harness/app-runtime")
DEFAULT_READINESS_TIMEOUT_SECONDS = 60
STARTUP_STABILITY_SECONDS = 1
COMPONENTS = ("infra", "server")
APP_ENVIRONMENTS = ("dev", "prod")
APP_ACTIONS = ("start", "stop", "health", "deploy", "env", "status")
APP_SCRIPT_CONTRACT: dict[str, dict[str, Path]] = {
    "dev": {
        "build-images": APP_DEV_BUILD_IMAGES_SCRIPT,
        "deploy": APP_DEV_DEPLOY_SCRIPT,
        "start": APP_DEV_START_SCRIPT,
        "stop": APP_DEV_STOP_SCRIPT,
        "health": APP_DEV_HEALTH_SCRIPT,
        "logs": APP_DEV_LOGS_SCRIPT,
    },
    "prod": {
        "build-images": APP_PROD_BUILD_IMAGES_SCRIPT,
        "deploy": APP_PROD_DEPLOY_SCRIPT,
        "start": APP_PROD_START_SCRIPT,
        "stop": APP_PROD_STOP_SCRIPT,
        "health": APP_PROD_HEALTH_SCRIPT,
        "logs": APP_PROD_LOGS_SCRIPT,
    },
}


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


def run_app_lifecycle(
    repo_root: Path | str,
    app_args: Sequence[str] = (),
    *,
    timeout: int = DEFAULT_READINESS_TIMEOUT_SECONDS,
) -> str:
    root = Path(repo_root).resolve()
    environment, action, passthrough = _parse_lifecycle_args(app_args)
    if action == "env":
        return _format_lifecycle_env(root, environment, timeout)
    if action == "status":
        return _lifecycle_status(root, environment, timeout)
    if action == "start":
        return _run_lifecycle_start(root, environment, passthrough, timeout)
    if action == "stop":
        completed = _run_lifecycle_script(root, environment, "stop", timeout=timeout)
        return _format_lifecycle_result(environment, "stop", completed)
    if action == "health":
        completed = _run_lifecycle_script(root, environment, "health", timeout=timeout)
        return _format_lifecycle_result(environment, "health", completed)
    if action == "deploy":
        completed = _run_lifecycle_script(
            root,
            environment,
            "deploy",
            args=passthrough,
            timeout=timeout,
        )
        return _format_lifecycle_result(environment, "deploy", completed)
    raise ValueError(f"unknown app action: {action}")


def app_status(repo_root: Path | str) -> str:
    root = Path(repo_root).resolve()
    if _has_lifecycle_dev_scripts(root):
        lines = ["Application runtime status:"]
        for environment in APP_ENVIRONMENTS:
            lines.append(f"- {environment} scripts: {_lifecycle_contract_status(root, environment)}")
            lines.append(f"- {environment} health: {_lifecycle_health_status(root, environment)}")
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
    for environment in APP_ENVIRONMENTS:
        if (root / APP_SCRIPT_CONTRACT[environment]["stop"]).is_file():
            _run_lifecycle_script(root, environment, "stop")
            messages.append(f"{environment} app runtime stopped.")
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
    return _lifecycle_contract_status(root, "dev")


def _lifecycle_contract_status(root: Path, environment: str) -> str:
    required = ("start", "stop", "health")
    missing = [
        str(APP_SCRIPT_CONTRACT[environment][action])
        for action in required
        if not (root / APP_SCRIPT_CONTRACT[environment][action]).is_file()
    ]
    return "configured" if not missing else "missing " + ", ".join(missing)


def _start_lifecycle_dev_app(
    root: Path,
    args: Sequence[str],
    *,
    timeout: int,
) -> str | int:
    try:
        _run_lifecycle_start(root, "dev", args, timeout)
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
        completed = _run_lifecycle_script(root, "dev", "health", check=False, timeout=10)
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


def _lifecycle_health_status(root: Path, environment: str) -> str:
    script = APP_SCRIPT_CONTRACT[environment]["health"]
    if not (root / script).is_file():
        return f"missing {script}"
    completed = _run_lifecycle_script(root, environment, "health", check=False, timeout=10)
    if completed.returncode == 0:
        return "healthy"
    detail = (completed.stderr or completed.stdout or "").strip().splitlines()
    suffix = f" ({detail[-1]})" if detail else ""
    return f"unhealthy{suffix}"


def _parse_lifecycle_args(args: Sequence[str]) -> tuple[str, str, tuple[str, ...]]:
    values = list(args)
    if values[:1] == ["--"]:
        values = values[1:]
    environment = "dev"
    action = "start"
    passthrough: list[str] = []
    index = 0
    while index < len(values):
        value = values[index]
        if value == "--env":
            if index + 1 >= len(values):
                raise ValueError("--env requires dev or prod")
            environment = _normalize_environment(values[index + 1])
            index += 2
            continue
        if value.startswith("--env="):
            environment = _normalize_environment(value.split("=", maxsplit=1)[1])
            index += 1
            continue
        if value in APP_ENVIRONMENTS:
            environment = value
            index += 1
            continue
        if value in APP_ACTIONS:
            action = value
            index += 1
            continue
        if value == "--":
            passthrough.extend(values[index + 1 :])
            break
        passthrough.append(value)
        index += 1
    return environment, action, tuple(passthrough)


def _normalize_environment(value: str) -> str:
    if value not in APP_ENVIRONMENTS:
        raise ValueError(f"unknown app environment: {value}")
    return value


def _run_lifecycle_start(
    root: Path,
    environment: str,
    args: Sequence[str],
    timeout: int,
) -> str:
    if timeout <= 0:
        raise ValueError("app readiness timeout must be greater than zero")
    if (root / APP_SCRIPT_CONTRACT[environment]["build-images"]).is_file():
        _run_lifecycle_script(root, environment, "build-images", timeout=timeout)
    completed = _run_lifecycle_script(
        root,
        environment,
        "start",
        args=args,
        timeout=timeout,
    )
    _wait_for_environment_health(root, environment, timeout)
    return "\n".join(
        [
            f"Application {environment} runtime started:",
            f"- start: {APP_SCRIPT_CONTRACT[environment]['start']}",
            f"- health: {APP_SCRIPT_CONTRACT[environment]['health']}",
            f"- env: harness run app {environment} env",
            _format_lifecycle_output(completed),
        ]
    ).strip()


def _wait_for_environment_health(root: Path, environment: str, timeout: int) -> None:
    deadline = time.monotonic() + timeout
    while True:
        completed = _run_lifecycle_script(
            root,
            environment,
            "health",
            check=False,
            timeout=10,
        )
        if completed.returncode == 0:
            return
        if time.monotonic() >= deadline:
            raise ValueError(f"{environment} runtime health check timed out after {timeout} seconds")
        time.sleep(1)


def _run_lifecycle_script(
    root: Path,
    environment: str,
    action: str,
    *,
    args: Sequence[str] = (),
    check: bool = True,
    timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
    script = APP_SCRIPT_CONTRACT[environment][action]
    if not (root / script).is_file():
        raise ValueError(_missing_lifecycle_script_message(environment, action, script))
    completed = subprocess.run(
        ["bash", str(root / script), *args],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
        env=_lifecycle_environment(root, environment, timeout),
    )
    if check and completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        suffix = f": {detail}" if detail else ""
        raise ValueError(f"{environment} {action} script failed: {script}{suffix}")
    return completed


def _missing_lifecycle_script_message(environment: str, action: str, script: Path) -> str:
    return "\n".join(
        [
            f"missing {environment} {action} script: {script}",
            "Create this script before retrying.",
            "Required contract:",
            "- executable shell script under repository root",
            "- exit 0 on success, non-zero on failure",
            "- read runtime configuration from environment variables shown by:",
            f"  harness run app {environment} env",
        ]
    )


def _lifecycle_environment(
    root: Path,
    environment: str,
    timeout: int | None = None,
) -> dict[str, str]:
    env = dict(os.environ)
    values = {
        "HARNESS_APP_ENV": environment,
        "HARNESS_APP_ROOT": str(root),
        "HARNESS_APP_SCRIPT_DIR": str(root / "scripts/app" / environment),
        "HARNESS_APP_LOG_DIR": str(root / APP_LOG_DIR),
        "HARNESS_APP_HEALTH_TIMEOUT_SECONDS": str(
            timeout or DEFAULT_READINESS_TIMEOUT_SECONDS
        ),
    }
    values.update(_load_env_file(root / APP_ENV_DIR / f"{environment}.env"))
    values.update(_load_env_file(root / "scripts/app" / environment / "env"))
    values.update(_load_env_file(root / "scripts/app" / environment / "env.local"))
    env.update(values)
    return env


def _load_env_file(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line.removeprefix("export ").strip()
        if "=" not in line:
            continue
        key, value = line.split("=", maxsplit=1)
        key = key.strip()
        if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", key):
            continue
        values[key] = _strip_env_value(value.strip())
    return values


def _strip_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _format_lifecycle_env(root: Path, environment: str, timeout: int) -> str:
    env = _lifecycle_environment(root, environment, timeout)
    keys = sorted(key for key in env if key.startswith("HARNESS_APP_"))
    env_files = (
        APP_ENV_DIR / f"{environment}.env",
        Path("scripts/app") / environment / "env",
        Path("scripts/app") / environment / "env.local",
    )
    lines = [
        f"Application {environment} runtime environment:",
        "Env files:",
        *[
            f"- {path}: {'present' if (root / path).is_file() else 'missing'}"
            for path in env_files
        ],
        "Values:",
        *[f"- {key}={env[key]}" for key in keys],
    ]
    return "\n".join(lines)


def _lifecycle_status(root: Path, environment: str, timeout: int) -> str:
    return "\n".join(
        [
            f"Application {environment} runtime status:",
            f"- scripts: {_lifecycle_contract_status(root, environment)}",
            f"- health: {_lifecycle_health_status(root, environment)}",
            "- env command: "
            f"harness run app {environment} env --env {environment}",
            f"- health timeout: {timeout}s",
        ]
    )


def _format_lifecycle_result(
    environment: str,
    action: str,
    completed: subprocess.CompletedProcess[str],
) -> str:
    lines = [
        f"Application {environment} {action}: {'ok' if completed.returncode == 0 else 'failed'}",
        f"- exit_code: {completed.returncode}",
    ]
    output = _format_lifecycle_output(completed)
    if output:
        lines.append(output)
    return "\n".join(lines)


def _format_lifecycle_output(completed: subprocess.CompletedProcess[str]) -> str:
    output = (completed.stdout or completed.stderr or "").strip()
    return f"- output: {output}" if output else ""


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
        APP_DEV_DEPLOY_SCRIPT,
        APP_DEV_START_SCRIPT,
        APP_DEV_STOP_SCRIPT,
        APP_DEV_HEALTH_SCRIPT,
        APP_DEV_LOGS_SCRIPT,
        APP_PROD_BUILD_IMAGES_SCRIPT,
        APP_PROD_DEPLOY_SCRIPT,
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
