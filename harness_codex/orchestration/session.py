"""Workflow orchestration agent session lifecycle."""

from __future__ import annotations

import json
import re
import tomllib
from dataclasses import dataclass, field, replace
from enum import Enum
from pathlib import Path
from typing import Mapping
from uuid import uuid4

from harness_codex.orchestration.session_store import (
    OrchestrationSessionBusy,
    OrchestrationSessionStore,
    TERMINAL_STATUSES,
    list_orchestration_checkpoints,
)

from harness_codex.runtime.agent_session import (
    AgentSessionAdapter,
    AgentSessionRequest,
    CancellationToken,
    CliAgentSessionAdapter,
)
from harness_codex.runtime.token_observability import collect_orchestration_metrics


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


def find_active_session_id(repo_root: Path | str, instruction: str) -> str | None:
    """Return newest matching non-terminal session; never create a duplicate."""

    root = Path(repo_root).resolve()
    fingerprint = OrchestrationSessionStore.fingerprint(root, instruction)
    matches = [
        item for item in list_orchestration_checkpoints(root)
        if item.get("request_fingerprint") == fingerprint and item.get("status") not in TERMINAL_STATUSES
    ]
    if not matches:
        return None
    matches.sort(key=lambda item: str(item.get("started_at") or ""), reverse=True)
    return str(matches[0]["session_id"])


def run_orchestration(
    request: OrchestrationRunRequest,
    *,
    session_adapter: AgentSessionAdapter | None = None,
) -> OrchestrationRunResult:
    root = Path(request.repo_root).resolve()
    session_id = request.session_id or uuid4().hex
    session_dir = root / ".harness" / "orchestration" / session_id
    current_artifact_run_dir = root / ".harness" / "runs" / session_id
    (current_artifact_run_dir / "steps").mkdir(parents=True, exist_ok=True)
    store = OrchestrationSessionStore(root, session_id)
    fingerprint = store.fingerprint(root, request.instruction)
    previous = store.read_checkpoint()
    if (
        request.session_id
        and previous.get("status") in TERMINAL_STATUSES
        and previous.get("request_fingerprint") == fingerprint
    ):
        return _result_from_checkpoint(session_id, previous)
    try:
        lease = store.acquire()
    except OrchestrationSessionBusy:
        return _result(
            session_id,
            session_dir,
            "blocked",
            "session_busy",
            "orchestration session is already running",
            metadata={"checkpoint_path": str(store.session_dir / "checkpoint.json")},
        )
    attempt = int(previous.get("attempt", 0)) + 1
    lease.checkpoint(
        {
            "session_id": session_id,
            "artifact_run_id": session_id,
            "repo_root": str(root),
            "request_fingerprint": fingerprint,
            "status": "running",
            "attempt": attempt,
            "started_at": _utc_now(),
        }
    )
    effective_request = replace(request, session_id=session_id)
    if not request.resume_provider_session_id and previous.get("provider_session_id"):
        effective_request = replace(
            effective_request,
            resume_provider_session_id=str(previous["provider_session_id"]),
        )
    try:
        result = _run_orchestration_unlocked(effective_request, session_adapter=session_adapter)
        checkpoint = _result_json(result)
        checkpoint.update(
            {
                "artifact_run_id": session_id,
                "request_fingerprint": fingerprint,
                "attempt": attempt,
                "checkpoint_path": str(store.session_dir / "checkpoint.json"),
                "finished_at": _utc_now(),
            }
        )
        lease.checkpoint(checkpoint)
        return result
    except BaseException as exc:
        result = _result(
            session_id,
            session_dir,
            "failed",
            "process_error",
            str(exc),
            metadata={"attempt": attempt},
        )
        lease.checkpoint(
            {
                **_result_json(result),
                "artifact_run_id": session_id,
                "request_fingerprint": fingerprint,
                "attempt": attempt,
                "finished_at": _utc_now(),
            }
        )
        return result
    finally:
        lease.close()


def _run_orchestration_unlocked(
    request: OrchestrationRunRequest,
    *,
    session_adapter: AgentSessionAdapter | None = None,
) -> OrchestrationRunResult:
    root = Path(request.repo_root).resolve()
    session_id = request.session_id or uuid4().hex
    session_dir = root / ".harness" / "orchestration" / session_id
    current_artifact_run_dir = root / ".harness" / "runs" / session_id
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
        session_id=session_id,
        current_artifact_run_dir=current_artifact_run_dir,
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
        _workflow_result_status(session_result.status, session_result.final_message),
        _workflow_termination_reason(session_result.status, session_result.termination_reason, session_result.final_message),
        session_result.error,
        final_response=session_result.final_message,
        provider_session_id=session_result.provider_session_id,
        prompt_path=prompt_path,
        final_message_path=session_result.artifact_paths.get("final_message"),
        stdout_path=session_result.artifact_paths.get("stdout"),
        stderr_path=session_result.artifact_paths.get("stderr"),
        metadata={
            "agent_config_path": str(config_path),
            "skill_path": str(skill_path),
            "provider_status": session_result.status,
            "workflow_status": _declared_workflow_status(session_result.final_message) or session_result.status,
        },
    )
    _write_json(session_dir / "result.json", _result_json(result))
    collect_orchestration_metrics(repo_root=root, run_id=session_id)
    return result


def _result_from_checkpoint(session_id: str, checkpoint: Mapping[str, object]) -> OrchestrationRunResult:
    def path_value(key: str) -> Path | None:
        value = checkpoint.get(key)
        return Path(str(value)) if value else None

    raw_status = str(checkpoint.get("status") or "failed")
    status = OrchestrationRunStatus(raw_status) if raw_status in {item.value for item in OrchestrationRunStatus} else OrchestrationRunStatus.FAILED
    return OrchestrationRunResult(
        session_id=session_id,
        status=status,
        termination_reason=str(checkpoint.get("termination_reason") or "replayed_terminal_session"),
        final_response=str(checkpoint.get("final_response") or ""),
        error=str(checkpoint.get("error") or ""),
        provider_session_id=str(checkpoint["provider_session_id"]) if checkpoint.get("provider_session_id") else None,
        prompt_path=path_value("prompt_path"),
        final_message_path=path_value("final_message_path"),
        stdout_path=path_value("stdout_path"),
        stderr_path=path_value("stderr_path"),
        metadata={**(checkpoint.get("metadata") if isinstance(checkpoint.get("metadata"), Mapping) else {}), "replayed": True},
    )


def _utc_now() -> str:
    from datetime import UTC, datetime

    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_orchestration_prompt(*, instruction: str, session_id: str = "", current_artifact_run_dir: Path | None = None, agent_config: Mapping[str, object], agent_config_path: Path, skill_path: Path, skill_body: str, repo_root: Path) -> str:
    """Assemble only selected agent/skill and runtime command surface once."""
    return "\n".join((
        "<agent_instruction>", str(agent_config["developer_instructions"]).strip(), "</agent_instruction>",
        "<skill_sequence>", skill_body.strip(), "</skill_sequence>",
        f"run_id: {session_id}", f"run_root: {current_artifact_run_dir}",
        "Use only runtime commands; direct shell reads, source work, agent spawning, and product commands are unavailable.",
        f"Context: python3 -m harness_codex.orchestration.runtime_context --repo-root . --run-id {session_id}",
        "Dispatch selected step (delegation, not step work): python3 -m harness_codex.orchestration.runtime_dispatch --repo-root . --run-id <RUN-ID> --step-id <STEP-ID> --change-set-id <CHG-ID> --work-item-id <WORK-ITEM-ID>",
        "Runtime returns facts. Select the next workflow step from facts; do not terminal-block while runtime facts identify a compatible owning step.",
        "<user_instruction>", instruction, "</user_instruction>",
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
    overrides = config.get("provider_config_overrides")
    if overrides is not None and (
        not isinstance(overrides, list)
        or not all(isinstance(value, str) and value.strip() for value in overrides)
    ):
        raise ValueError("provider_config_overrides must be a list of non-empty strings")
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


_WORKFLOW_STATUS_PATTERN = re.compile(r"^\s*Workflow Status:\s*(succeeded|failed|blocked|cancelled)\s*$", re.MULTILINE)


def _declared_workflow_status(final_message: str) -> str | None:
    match = _WORKFLOW_STATUS_PATTERN.search(final_message or "")
    return match.group(1) if match else None


def _workflow_result_status(provider_status: str, final_message: str) -> str:
    return _declared_workflow_status(final_message) or provider_status


def _workflow_termination_reason(provider_status: str, provider_reason: str, final_message: str) -> str:
    declared = _declared_workflow_status(final_message)
    if declared and declared != provider_status:
        return f"workflow_{declared}"
    return provider_reason


def _write_json(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


__all__ = ["OrchestrationRunRequest", "OrchestrationRunResult", "OrchestrationRunStatus", "build_orchestration_prompt", "find_active_session_id", "run_orchestration"]
