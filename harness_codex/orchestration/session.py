"""Workflow orchestration agent session lifecycle."""

from __future__ import annotations

import json
import tomllib
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Mapping
from uuid import uuid4

from harness_codex.runtime.agent_session import (
    AgentSessionAdapter,
    AgentSessionRequest,
    CancellationToken,
    CliAgentSessionAdapter,
)


class OrchestrationRunStatus(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


@dataclass(frozen=True)
class OrchestrationRunRequest:
    repo_root: Path
    instruction: str
    session_id: str | None = None
    resume_provider_session_id: str | None = None
    timeout_sec: int = 3600
    cancellation: CancellationToken | None = None


@dataclass(frozen=True)
class OrchestrationRunResult:
    session_id: str
    status: OrchestrationRunStatus
    termination_reason: str
    final_response: str = ""
    error: str = ""
    provider_session_id: str | None = None
    prompt_path: Path | None = None
    final_message_path: Path | None = None
    stdout_path: Path | None = None
    stderr_path: Path | None = None
    metadata: Mapping[str, object] = field(default_factory=dict)


def run_orchestration(
    request: OrchestrationRunRequest,
    *,
    session_adapter: AgentSessionAdapter | None = None,
) -> OrchestrationRunResult:
    root = Path(request.repo_root).resolve()
    session_id = request.session_id or uuid4().hex
    session_dir = root / ".harness" / "orchestration" / session_id
    config_path = root / ".codex" / "agents" / "workflow_orchestrator.toml"
    skill_path = root / ".codex" / "skills" / "harness-orchestrate-instruction" / "SKILL.md"
    session_dir.mkdir(parents=True, exist_ok=True)
    _write_json(session_dir / "request.json", {
        "session_id": session_id,
        "repo_root": str(root),
        "instruction": request.instruction,
        "timeout_sec": request.timeout_sec,
        "resume_provider_session_id": request.resume_provider_session_id,
    })
    if not request.instruction.strip():
        return _result(session_id, session_dir, "blocked", "invalid_agent_config", "instruction is required")
    try:
        config = _load_config(config_path)
    except FileNotFoundError:
        return _result(session_id, session_dir, "blocked", "missing_agent_config", str(config_path))
    except (OSError, tomllib.TOMLDecodeError, ValueError) as exc:
        return _result(session_id, session_dir, "blocked", "invalid_agent_config", str(exc))
    if not skill_path.is_file():
        return _result(session_id, session_dir, "blocked", "missing_skill", str(skill_path))
    try:
        skill_body = skill_path.read_text(encoding="utf-8")
    except OSError as exc:
        return _result(session_id, session_dir, "blocked", "missing_skill", str(exc))
    prompt = build_orchestration_prompt(
        instruction=request.instruction,
        agent_config=config,
        agent_config_path=config_path,
        skill_path=skill_path,
        skill_body=skill_body,
        repo_root=root,
    )
    prompt_path = session_dir / "prompt.md"
    prompt_path.write_text(prompt, encoding="utf-8")
    adapter = session_adapter or CliAgentSessionAdapter()
    try:
        session_result = adapter.run(
            AgentSessionRequest(
                repo_root=root,
                session_dir=session_dir,
                agent_config_path=config_path,
                agent_config=config,
                prompt=prompt,
                timeout_sec=request.timeout_sec,
                resume_provider_session_id=request.resume_provider_session_id,
                cancellation=request.cancellation,
            )
        )
    except Exception as exc:
        return _result(session_id, session_dir, "failed", "process_error", str(exc), prompt_path=prompt_path)
    result = _result(
        session_id,
        session_dir,
        session_result.status,
        session_result.termination_reason,
        session_result.error,
        final_response=session_result.final_message,
        provider_session_id=session_result.provider_session_id,
        prompt_path=prompt_path,
        final_message_path=session_result.artifact_paths.get("final_message"),
        stdout_path=session_result.artifact_paths.get("stdout"),
        stderr_path=session_result.artifact_paths.get("stderr"),
        metadata={"agent_config_path": str(config_path), "skill_path": str(skill_path)},
    )
    _write_json(session_dir / "result.json", _result_json(result))
    return result


def build_orchestration_prompt(*, instruction: str, agent_config: Mapping[str, object], agent_config_path: Path, skill_path: Path, skill_body: str, repo_root: Path) -> str:
    developer_instructions = str(agent_config.get("developer_instructions") or "").strip()
    return "\n".join((
        "<orchestration_agent>",
        f"config_path: {agent_config_path}",
        f"repository_root: {repo_root}",
        "<developer_instructions>",
        developer_instructions,
        "</developer_instructions>",
        f"<skill path=\"{skill_path}\">",
        skill_body,
        "</skill>",
        "<available_tools>",
        "orchestration agent가 native subagent capability를 직접 호출한다.",
        "Python runtime과 runtime service는 subagent를 생성하거나 실행하지 않는다.",
        "호출 전에 agent_id TOML과 skill_id SKILL.md를 로드하고 workflow needs를 확인한 뒤 기존 subagent-invocation-v1.xsd payload를 만든다.",
        "호출 후 subagent-result-v1.xsd payload 하나를 요구하고 검증한다.",
        "지원하지 않는 tool은 unavailable 상태로 유지한다.",
        "</available_tools>",
        "</orchestration_agent>",
        "<user_instruction>",
        instruction,
        "</user_instruction>",
        "Return the final user response without delegating workflow decisions to the host.",
        "",
    ))


def _load_config(path: Path) -> dict[str, object]:
    if not path.is_file():
        raise FileNotFoundError(path)
    config = tomllib.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config.get("name"), str) or not config["name"].strip():
        raise ValueError("orchestration config requires name")
    if not isinstance(config.get("developer_instructions"), str) or not config["developer_instructions"].strip():
        raise ValueError("orchestration config requires developer_instructions")
    provider = str(config.get("provider") or "codex").strip()
    if provider not in {"codex", "custom_cli"}:
        raise ValueError(f"unsupported agent provider: {provider}")
    if provider == "custom_cli":
        command = config.get("provider_command")
        if not isinstance(command, list) or not command or not all(isinstance(item, str) and item for item in command):
            raise ValueError("custom_cli provider requires provider_command")
    binary = config.get("provider_binary")
    if binary is not None and (not isinstance(binary, str) or not binary.strip()):
        raise ValueError("provider_binary must be a non-empty string")
    return config


def _result(session_id: str, session_dir: Path, status: str, reason: str, error: str = "", *, final_response: str = "", provider_session_id: str | None = None, prompt_path: Path | None = None, final_message_path: Path | None = None, stdout_path: Path | None = None, stderr_path: Path | None = None, metadata: Mapping[str, object] | None = None) -> OrchestrationRunResult:
    normalized = OrchestrationRunStatus.CANCELLED if status == "cancelled" else OrchestrationRunStatus(status if status in {item.value for item in OrchestrationRunStatus} else "failed")
    result = OrchestrationRunResult(session_id, normalized, reason, final_response, error, provider_session_id, prompt_path, final_message_path, stdout_path, stderr_path, metadata or {})
    _write_json(session_dir / "result.json", _result_json(result))
    return result


def _result_json(result: OrchestrationRunResult) -> dict[str, object]:
    return {
        "session_id": result.session_id,
        "status": result.status.value,
        "termination_reason": result.termination_reason,
        "final_response": result.final_response,
        "error": result.error,
        "provider_session_id": result.provider_session_id,
        "prompt_path": str(result.prompt_path) if result.prompt_path else None,
        "final_message_path": str(result.final_message_path) if result.final_message_path else None,
        "stdout_path": str(result.stdout_path) if result.stdout_path else None,
        "stderr_path": str(result.stderr_path) if result.stderr_path else None,
        "metadata": dict(result.metadata),
    }


def _write_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


__all__ = ["OrchestrationRunRequest", "OrchestrationRunResult", "OrchestrationRunStatus", "build_orchestration_prompt", "run_orchestration"]
