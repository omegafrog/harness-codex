"""사용자 요청을 workflow orchestration agent에 전달하는 경계."""

from __future__ import annotations

import os
import subprocess
import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class OrchestratorInvocationResult:
    """Orchestration agent 호출의 관측 결과."""

    status: str
    output: str = ""
    error: str | None = None


def invoke_orchestrator(
    user_prompt: str,
    *,
    repo_root: Path | str | None = None,
    codex_binary: str = "codex",
    timeout_seconds: int | None = None,
) -> OrchestratorInvocationResult:
    """사용자 prompt를 workflow orchestration agent에 원문 그대로 전달한다."""

    prompt = user_prompt.strip()
    if not prompt:
        raise ValueError("user_prompt is required")

    root = Path(repo_root or ".").resolve()
    config_path = root / ".codex" / "agents" / "workflow_orchestrator.toml"
    if not config_path.is_file():
        return OrchestratorInvocationResult(
            status="failed",
            error=f"orchestration agent config not found: {config_path}",
        )
    try:
        agent_config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        return OrchestratorInvocationResult(
            status="failed",
            error=f"orchestration agent config is invalid: {exc}",
        )
    instructions = str(agent_config.get("developer_instructions") or "").strip()

    timeout = timeout_seconds or int(
        os.environ.get("HARNESS_ORCHESTRATOR_TIMEOUT_SECONDS", "3600")
    )
    command = [
        codex_binary,
        "exec",
        "--cd",
        str(root),
        "--skip-git-repo-check",
        "--model",
        os.environ.get("HARNESS_ORCHESTRATOR_MODEL", "gpt-5.4-mini"),
        "-c",
        'approval_policy="never"',
        "--sandbox",
        "workspace-write",
        "-",
    ]
    request = (
        "<user_request>\n"
        f"{user_prompt}\n"
        "</user_request>\n\n"
        "<runtime_context>\n"
        f"repository_root: {root}\n"
        f"orchestration_agent_config: {config_path}\n"
        "<orchestration_agent_instructions>\n"
        f"{instructions}\n"
        "</orchestration_agent_instructions>\n"
        "Use the configured workflow_orchestrator agent. Runtime is only a local utility boundary; "
        "do not delegate workflow progression to runtime.\n"
        "</runtime_context>\n"
    )
    try:
        completed = subprocess.run(
            command,
            cwd=root,
            input=request,
            text=True,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return OrchestratorInvocationResult(
            status="timed_out",
            error=f"orchestration agent timed out after {timeout} seconds",
        )
    except KeyboardInterrupt:
        return OrchestratorInvocationResult(status="cancelled")
    except OSError as exc:
        return OrchestratorInvocationResult(status="failed", error=str(exc))

    output = (completed.stdout or "").strip()
    error = (completed.stderr or "").strip() or None
    if completed.returncode != 0:
        return OrchestratorInvocationResult(
            status="failed",
            output=output,
            error=error or f"orchestration agent exited with status {completed.returncode}",
        )
    return OrchestratorInvocationResult(status="completed", output=output, error=error)


__all__ = ["OrchestratorInvocationResult", "invoke_orchestrator"]
