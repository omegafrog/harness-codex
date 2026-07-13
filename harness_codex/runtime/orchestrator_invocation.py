"""사용자 요청을 workflow orchestration agent에 전달하는 경계."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from harness_codex.runtime.agent_session import AgentSessionAdapter, CliAgentSessionAdapter


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
    session_id: str | None = None,
    resume_provider_session_id: str | None = None,
    resume: bool = False,
    session_adapter: AgentSessionAdapter | None = None,
) -> OrchestratorInvocationResult:
    """공개 orchestrate 요청을 durable orchestration session으로 실행한다."""

    from harness_codex.orchestration.session import (
        OrchestrationRunRequest,
        OrchestrationRunStatus,
        run_orchestration,
    )

    prompt = user_prompt.strip()
    if not prompt:
        raise ValueError("user_prompt is required")

    root = Path(repo_root or ".").resolve()
    timeout = timeout_seconds or int(
        os.environ.get("HARNESS_ORCHESTRATOR_TIMEOUT_SECONDS", "3600")
    )
    adapter = session_adapter or CliAgentSessionAdapter(default_binary=codex_binary)
    result = run_orchestration(
        OrchestrationRunRequest(
            repo_root=root,
            instruction=user_prompt,
            session_id=session_id,
            resume_provider_session_id=resume_provider_session_id,
            resume=resume,
            timeout_sec=timeout,
        ),
        session_adapter=adapter,
    )
    status = "completed" if result.status is OrchestrationRunStatus.SUCCEEDED else result.status.value
    return OrchestratorInvocationResult(
        status=status,
        output=result.final_response,
        error=result.error or None,
    )


__all__ = ["OrchestratorInvocationResult", "invoke_orchestrator"]
