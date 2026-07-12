"""재사용 가능한 provider agent session process 경계."""

from __future__ import annotations

import json
import os
import shlex
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Mapping, Protocol


class CancellationToken(Protocol):
    def is_cancelled(self) -> bool:
        ...


@dataclass(frozen=True)
class AgentSessionRequest:
    repo_root: Path
    session_dir: Path
    agent_config_path: Path
    agent_config: Mapping[str, object]
    prompt: str
    timeout_sec: int
    resume_provider_session_id: str | None = None
    cancellation: CancellationToken | None = None
    specialist_run_id: str | None = None
    verification_observation_budget_sec: int | None = None


@dataclass(frozen=True)
class AgentSessionResult:
    status: str
    termination_reason: str
    final_message: str = ""
    error: str = ""
    exit_code: int | None = None
    provider_session_id: str | None = None
    artifact_paths: Mapping[str, Path] = field(default_factory=dict)


class AgentSessionAdapter(Protocol):
    def run(self, request: AgentSessionRequest) -> AgentSessionResult:
        ...


class CliAgentSessionAdapter:
    """Run one configured provider process without workflow interpretation."""

    def __init__(self, *, default_binary: str = "codex", poll_interval_sec: float = 0.05) -> None:
        self.default_binary = default_binary
        self.poll_interval_sec = poll_interval_sec

    def run(self, request: AgentSessionRequest) -> AgentSessionResult:
        session_dir = request.session_dir
        session_dir.mkdir(parents=True, exist_ok=True)
        stdout_path = session_dir / "stdout.txt"
        stderr_path = session_dir / "stderr.txt"
        final_message_path = session_dir / "final-message.md"
        command = self._command(request, final_message_path)
        (session_dir / "command.json").write_text(
            json.dumps(command, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        stdout_path.write_text("", encoding="utf-8")
        stderr_path.write_text("", encoding="utf-8")
        try:
            process = subprocess.Popen(
                command,
                cwd=request.repo_root,
                stdin=subprocess.PIPE,
                stdout=stdout_path.open("w", encoding="utf-8"),
                stderr=stderr_path.open("w", encoding="utf-8"),
                text=True,
                start_new_session=(os.name != "nt"),
                preexec_fn=_provider_child_setup if os.name != "nt" else None,
            )
            if process.stdin is not None:
                process.stdin.write(request.prompt)
                process.stdin.close()
        except (OSError, ValueError) as exc:
            return self._result(request, "blocked", "provider_not_found", str(exc), None)

        started = time.monotonic()
        observed_command = ""
        observation_started = 0.0
        reason = "process_error"
        while process.poll() is None:
            violation = _orchestrator_boundary_violation(request, stdout_path)
            violation = violation or _specialist_boundary_violation(request, stdout_path)
            if violation:
                self._terminate(process)
                return self._result(
                    request,
                    "failed",
                    "orchestrator_boundary_violation",
                    violation,
                    process.poll(),
                )
            active_verification = _active_verification_command(stdout_path)
            if active_verification != observed_command:
                observed_command = active_verification or ""
                observation_started = time.monotonic() if active_verification else 0.0
            budget = request.verification_observation_budget_sec
            if active_verification and budget and time.monotonic() - observation_started >= budget:
                self._terminate(process)
                return self._result(
                    request,
                    "failed",
                    "verification_observation_timeout",
                    f"verification observation budget exceeded ({budget}s): {active_verification}",
                    process.poll(),
                )
            if request.cancellation is not None and request.cancellation.is_cancelled():
                self._terminate(process)
                reason = "cancelled"
                break
            if time.monotonic() - started >= request.timeout_sec:
                self._terminate(process)
                reason = "timeout"
                break
            time.sleep(self.poll_interval_sec)
        exit_code = process.poll()
        if reason in {"cancelled", "timeout"}:
            return self._result(
                request,
                "cancelled" if reason == "cancelled" else "failed",
                reason,
                self._stderr(stderr_path),
                exit_code,
            )

        final_message = self._final_message(request, final_message_path, stdout_path)
        if exit_code != 0:
            return self._result(request, "failed", "process_error", self._stderr(stderr_path) or final_message, exit_code)
        if not final_message.strip():
            return self._result(request, "failed", "missing_final_response", "final response is empty", exit_code)
        return self._result(
            request,
            "succeeded",
            "completed",
            "",
            exit_code,
            final_message=final_message,
        )

    def _command(self, request: AgentSessionRequest, final_message_path: Path) -> list[str]:
        config = request.agent_config
        provider = str(config.get("provider") or "codex").strip()
        if provider == "custom_cli":
            command = config.get("provider_command")
            if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
                raise ValueError("custom_cli provider requires provider_command")
            return list(command)
        if provider != "codex":
            raise ValueError(f"unsupported agent provider: {provider}")
        binary = str(config.get("provider_binary") or self.default_binary).strip()
        command = [binary, "exec"]
        if request.resume_provider_session_id:
            command.append("resume")
            command.append(request.resume_provider_session_id)
        command.extend(["--skip-git-repo-check", "-c", 'approval_policy="never"', "--json", "--output-last-message", str(final_message_path.resolve())])
        if not request.resume_provider_session_id:
            command.extend(["--cd", str(request.repo_root.resolve())])
        for override in _provider_config_overrides(config):
            command.extend(["-c", override])
        model = str(config.get("model") or "").strip()
        if model:
            command.extend(["--model", model])
        sandbox = str(config.get("sandbox_mode") or "").strip()
        if sandbox:
            if request.resume_provider_session_id:
                command.extend(["-c", f'sandbox_mode="{sandbox}"'])
            else:
                command.extend(["--sandbox", sandbox])
        command.append("-")
        return command

    def _result(self, request: AgentSessionRequest, status: str, reason: str, error: str, exit_code: int | None, *, final_message: str = "") -> AgentSessionResult:
        final_path = request.session_dir / "final-message.md"
        if final_message:
            final_path.write_text(final_message, encoding="utf-8")
        return AgentSessionResult(
            status=status,
            termination_reason=reason,
            final_message=final_message,
            error=error,
            exit_code=exit_code,
            provider_session_id=_provider_session_id(request.session_dir / "stdout.txt"),
            artifact_paths={
                "command": request.session_dir / "command.json",
                "stdout": request.session_dir / "stdout.txt",
                "stderr": request.session_dir / "stderr.txt",
                "final_message": final_path,
            },
        )

    @staticmethod
    def _final_message(request: AgentSessionRequest, final_path: Path, stdout_path: Path) -> str:
        try:
            value = final_path.read_text(encoding="utf-8")
        except OSError:
            value = ""
        if value.strip():
            return value
        if str(request.agent_config.get("provider") or "codex") in {"custom_cli", "ollama"}:
            try:
                return stdout_path.read_text(encoding="utf-8")
            except OSError:
                return ""
        return ""

    @staticmethod
    def _stderr(path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8").strip()
        except OSError:
            return ""

    @staticmethod
    def _terminate(process: subprocess.Popen[str]) -> None:
        if process.poll() is not None:
            return
        if os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except OSError:
                process.terminate()
        else:
            process.terminate()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except OSError:
                    process.kill()
            else:
                process.kill()
        if os.name != "nt":
            # The provider may have spawned descendants that outlive the parent.
            # Reap the whole private process group after the parent exits too.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                pass


def _provider_session_id(path: Path) -> str | None:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            value = json.loads(line)
        except (TypeError, ValueError):
            continue
        if isinstance(value, Mapping):
            for key in ("session_id", "thread_id", "conversation_id"):
                candidate = value.get(key)
                if isinstance(candidate, str) and candidate:
                    return candidate
    return None


def _orchestrator_boundary_violation(request: AgentSessionRequest, stdout_path: Path) -> str | None:
    """Reject product-command execution by the orchestration parent process."""

    if request.agent_config.get("name") != "workflow_orchestrator":
        return None
    try:
        lines = stdout_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        item = event.get("item") if isinstance(event, Mapping) else None
        if not isinstance(item, Mapping):
            continue
        if item.get("type") == "collab_tool_call" and str(item.get("tool") or "") == "spawn_agent":
            return "orchestrator attempted forbidden native specialist spawn; use runtime specialist_dispatch"
        if item.get("type") != "command_execution":
            continue
        command = str(item.get("command") or "")
        if not _allowed_orchestrator_command(command, request.session_dir.name):
            return f"orchestrator attempted command outside runtime allowlist: {command}"
    return None


def _allowed_orchestrator_command(command: str, run_id: str) -> bool:
    """Permit only runtime context/dispatch commands bound to this parent run."""
    try:
        outer = shlex.split(command)
    except ValueError:
        return False
    if "-lc" not in outer:
        return False
    inner = outer[outer.index("-lc") + 1]
    if any(token in inner for token in (";", "&&", "||", "|", "`", "$", "*")):
        return False
    try:
        parts = shlex.split(inner)
    except ValueError:
        return False
    if len(parts) < 3 or parts[0] not in {"python3", "python"} or parts[1:3] != ["-m", "harness_codex.orchestration.runtime_context"] and parts[1:3] != ["-m", "harness_codex.orchestration.runtime_dispatch"]:
        return False
    if parts[-1] == "--help":
        return True
    if "--run-id" not in parts:
        return False
    position = parts.index("--run-id")
    return position + 1 < len(parts) and parts[position + 1] == run_id


def _specialist_boundary_violation(request: AgentSessionRequest, stdout_path: Path) -> str | None:
    """Keep specialist evidence inside its dispatched run namespace."""
    run_id = request.specialist_run_id
    if not run_id:
        return None
    try:
        lines = stdout_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        item = event.get("item") if isinstance(event, Mapping) else None
        if not isinstance(item, Mapping) or item.get("type") != "command_execution":
            continue
        command = str(item.get("command") or "")
        lowered = command.lower()
        if any(token in lowered for token in ("find .harness/runs", "rg .harness/runs", ".harness/runs -g")):
            return f"specialist attempted broad prior-run search: {command}"
        if ".harness/runs/" in command and f".harness/runs/{run_id}/" not in command:
            return f"specialist attempted prior-run access: {command}"
    return None


def _active_verification_command(stdout_path: Path) -> str | None:
    """Return currently running Gradle/Maven/npm command from provider JSON."""
    states: dict[str, tuple[str, str]] = {}
    try:
        lines = stdout_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        item = event.get("item") if isinstance(event, Mapping) else None
        if not isinstance(item, Mapping) or item.get("type") != "command_execution":
            continue
        command = str(item.get("command") or "")
        if not any(token in command.lower() for token in ("gradlew", " gradle ", "mvn", "npm ")):
            continue
        key = str(item.get("id") or command)
        states[key] = (str(item.get("status") or ""), command)
    running = [command for status, command in states.values() if status == "in_progress"]
    return running[-1] if running else None


def _provider_config_overrides(config: Mapping[str, object]) -> tuple[str, ...]:
    """Return explicit, bounded Codex config overrides from the agent config."""

    raw = config.get("provider_config_overrides")
    if raw is None:
        if config.get("name") == "workflow_orchestrator":
            return (
                "mcp_servers.serena.enabled=false",
                "mcp_servers.playwright.enabled=false",
                "mcp_servers.graphify.enabled=false",
            )
        return ()
    if not isinstance(raw, list) or not all(isinstance(value, str) and value.strip() for value in raw):
        raise ValueError("provider_config_overrides must be a list of non-empty strings")
    return tuple(value.strip() for value in raw)


def _provider_child_setup() -> None:
    """Unexpected runtime-parent death also terminates the provider on Linux."""

    if os.name == "nt":
        return
    try:
        import ctypes

        libc = ctypes.CDLL(None)
        libc.prctl(1, signal.SIGTERM, 0, 0, 0)  # PR_SET_PDEATHSIG
    except (AttributeError, OSError):
        # Process-group cleanup remains the portable fallback.
        return


__all__ = ["AgentSessionAdapter", "AgentSessionRequest", "AgentSessionResult", "CancellationToken", "CliAgentSessionAdapter"]
