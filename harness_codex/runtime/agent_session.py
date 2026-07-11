"""재사용 가능한 provider agent session process 경계."""

from __future__ import annotations

import json
import os
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
        reason = "process_error"
        while process.poll() is None:
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
