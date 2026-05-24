"""Step runner boundary for runtime execution."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    Step,
    StepKind,
    StepResult,
    StepStatus,
)
from harness_codex.runtime.prompt import build_agent_prompt


@dataclass(frozen=True)
class AgentRunRequest:
    """전담 에이전트 호출에 필요한 입력."""

    step: Step
    context: RunContext
    step_dir: Path
    agent_config_path: Path
    agent_config: Mapping[str, Any]
    skill_path: Path | None = None
    skill_body: str | None = None


@dataclass(frozen=True)
class AgentRunResult:
    """전담 에이전트 호출 결과."""

    status: StepStatus
    exit_code: int | None = None
    error: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


class AgentAdapter(Protocol):
    def run(self, request: AgentRunRequest) -> AgentRunResult:
        """전담 에이전트를 실행하고 구조화된 결과를 반환한다."""
        ...


class StepRunner(Protocol):
    def run(self, step: Step, context: RunContext) -> StepResult:
        """Execute one step and return a structured result."""
        ...


class ConfigurableCliAgentAdapter:
    """Run agent steps through the provider configured in `.codex/agents/*.toml`."""

    def __init__(self, codex_binary: str = "codex") -> None:
        self._codex_binary = codex_binary

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        prompt_path = request.step_dir / "prompt.md"
        final_message_path = request.step_dir / "final-message.md"
        command_path = request.step_dir / "command.json"
        request.step_dir.mkdir(parents=True, exist_ok=True)

        prompt = build_agent_prompt(
            step=request.step,
            context=request.context,
            agent_config=request.agent_config,
            agent_config_path=_relative_to_repo(request.agent_config_path, request.context),
            skill_path=request.skill_path,
            skill_body=request.skill_body,
        )
        prompt_path.write_text(prompt, encoding="utf-8")
        _write_run_root_artifact_reference(
            request,
            f"prompt-{request.step.id}.md",
            prompt_path,
        )

        provider_result = _resolve_provider_command(
            request,
            final_message_path,
            default_codex_binary=self._codex_binary,
        )
        if isinstance(provider_result, AgentRunResult):
            stdout_path = request.step_dir / "stdout.txt"
            stderr_path = request.step_dir / "stderr.txt"
            stdout_path.write_text("", encoding="utf-8")
            stderr_path.write_text(provider_result.error or "", encoding="utf-8")
            command_path.write_text("[]\n", encoding="utf-8")
            _mirror_agent_artifacts(request, stdout_path, stderr_path, None, provider_result)
            return provider_result

        command, provider_metadata = provider_result
        command_path.write_text(
            json.dumps(command, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        try:
            completed = subprocess.run(
                command,
                cwd=request.context.workdir,
                input=prompt,
                text=True,
                capture_output=True,
                timeout=request.step.timeout_sec,
                check=False,
            )
        except FileNotFoundError as exc:
            binary = command[0] if command else "<empty>"
            provider = provider_metadata["provider"]
            error = f"agent provider binary not found: provider={provider} binary={binary}"
            stdout_path = request.step_dir / "stdout.txt"
            stderr_path = request.step_dir / "stderr.txt"
            stdout_path.write_text("", encoding="utf-8")
            stderr_path.write_text(error, encoding="utf-8")
            result = AgentRunResult(
                status=StepStatus.BLOCKED,
                error=error,
                metadata={
                    **_agent_metadata(request, prompt_path, final_message_path, error=str(exc)),
                    **provider_metadata,
                },
            )
            _mirror_agent_artifacts(request, stdout_path, stderr_path, None, result)
            return result
        except subprocess.TimeoutExpired as exc:
            stdout = _decode_process_output(exc.stdout)
            stderr = _decode_process_output(exc.stderr)
            error = f"agent step timed out after {request.step.timeout_sec} seconds"
            stdout_path = request.step_dir / "stdout.txt"
            stderr_path = request.step_dir / "stderr.txt"
            stdout_path.write_text(stdout, encoding="utf-8")
            stderr_path.write_text(stderr or error, encoding="utf-8")
            result = AgentRunResult(
                status=StepStatus.FAILED,
                error=error,
                metadata={
                    **_agent_metadata(request, prompt_path, final_message_path, error=str(exc)),
                    **provider_metadata,
                },
            )
            _mirror_agent_artifacts(request, stdout_path, stderr_path, None, result)
            return result

        stdout_path = request.step_dir / "stdout.txt"
        stderr_path = request.step_dir / "stderr.txt"
        stdout_path.write_text(completed.stdout, encoding="utf-8")
        stderr_path.write_text(completed.stderr, encoding="utf-8")
        if provider_metadata["provider"] == "custom_cli":
            final_message_path.write_text(completed.stdout, encoding="utf-8")

        if completed.returncode != 0:
            error = completed.stderr.strip() or completed.stdout.strip()
            blocker = _agent_process_blocker_error(error)
            status = StepStatus.BLOCKED if blocker is not None else StepStatus.FAILED
            result = AgentRunResult(
                status=status,
                exit_code=completed.returncode,
                error=blocker or error,
                metadata={
                    **_agent_metadata(request, prompt_path, final_message_path),
                    **provider_metadata,
                },
            )
            _mirror_agent_artifacts(request, stdout_path, stderr_path, final_message_path, result)
            return result

        result = AgentRunResult(
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            metadata={
                **_agent_metadata(request, prompt_path, final_message_path),
                **provider_metadata,
            },
        )
        _mirror_agent_artifacts(request, stdout_path, stderr_path, final_message_path, result)
        return result


class CodexCliAgentAdapter(ConfigurableCliAgentAdapter):
    """Backward-compatible Codex adapter name."""


class BasicStepRunner:
    """Local MVP adapter for record/shell/validator/git steps."""

    def __init__(self, agent_adapter: AgentAdapter | None = None) -> None:
        self._agent_adapter = agent_adapter or ConfigurableCliAgentAdapter()

    def run(self, step: Step, context: RunContext) -> StepResult:
        step_dir = context.run_dir / "steps" / step.id
        step_dir.mkdir(parents=True, exist_ok=True)

        if step.kind == StepKind.RECORD:
            return self._run_record(step, context, step_dir)
        if step.kind in {StepKind.SHELL, StepKind.VALIDATOR}:
            return self._run_command(step, context, step_dir)
        if step.kind == StepKind.GIT:
            return self._run_git_boundary(step, context, step_dir)
        if step.kind == StepKind.AGENT:
            return self._run_agent(step, context, step_dir)

        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)

    def _run_agent(self, step: Step, context: RunContext, step_dir: Path) -> StepResult:
        if not step.agent_id:
            return _blocked_agent_result(step, context, step_dir, "agent_id is required")

        agent_config_path = context.repo_root / ".codex/agents" / f"{step.agent_id}.toml"
        if not agent_config_path.exists():
            return _blocked_agent_result(
                step,
                context,
                step_dir,
                f"missing agent config: {_relative_to_repo(agent_config_path, context)}",
            )

        agent_config = _load_agent_config(agent_config_path)
        preflight_error = _implementation_environment_preflight(step, context, step_dir, agent_config)
        if preflight_error is not None:
            return _blocked_agent_result(step, context, step_dir, preflight_error)

        skill_id = _step_skill_id(step)
        skill_path: Path | None = None
        skill_body: str | None = None
        if skill_id is not None:
            skill_path = context.repo_root / ".codex/skills" / skill_id / "SKILL.md"
            if not skill_path.exists():
                return _blocked_agent_result(
                    step,
                    context,
                    step_dir,
                    f"missing skill config: {_relative_to_repo(skill_path, context)}",
                )
            skill_body = skill_path.read_text(encoding="utf-8")

        invocation_path = step_dir / "invocation.json"
        invocation_path.write_text(
            json.dumps(
                _agent_invocation_manifest(step, context, agent_config_path, skill_path),
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        result = self._agent_adapter.run(
            AgentRunRequest(
                step=step,
                context=context,
                step_dir=step_dir,
                agent_config_path=agent_config_path,
                agent_config=agent_config,
                skill_path=skill_path,
                skill_body=skill_body,
            )
        )
        result_path = step_dir / "result.json"
        validation_error = None
        if result.status == StepStatus.SUCCEEDED:
            validation_error = _validate_agent_outputs(step, context)
            if validation_error:
                result = AgentRunResult(
                    status=StepStatus.FAILED,
                    exit_code=result.exit_code,
                    error=validation_error,
                    metadata=result.metadata,
                )
        result_path.write_text(
            json.dumps(
                {
                    "step_id": step.id,
                    "agent_id": step.agent_id,
                    "skill_id": skill_id,
                    "status": result.status.value,
                    "exit_code": result.exit_code,
                    "error": result.error,
                    "metadata": dict(result.metadata),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        _write_response_snapshot(context, step.id, result_path)
        return StepResult(
            step_id=step.id,
            status=result.status,
            exit_code=result.exit_code,
            output_path=_relative_to_repo(result_path, context),
            error=result.error,
            failure_kind=_agent_failure_kind(result.status),
            metadata=result.metadata,
        )

    def _run_record(self, step: Step, context: RunContext, step_dir: Path) -> StepResult:
        missing = tuple(path for path in step.inputs if not (context.repo_root / path).exists())
        evidence = step_dir / "record.json"
        evidence.write_text(
            json.dumps({"step_id": step.id, "missing_inputs": [str(path) for path in missing]}, indent=2)
            + "\n",
            encoding="utf-8",
        )
        if missing:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                output_path=_relative_to_repo(evidence, context),
                error="missing inputs: " + ", ".join(str(path) for path in missing),
            )
        for output in step.outputs:
            (context.repo_root / output).parent.mkdir(parents=True, exist_ok=True)
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED, output_path=_relative_to_repo(evidence, context))

    def _run_command(self, step: Step, context: RunContext, step_dir: Path) -> StepResult:
        if not step.command:
            return StepResult(step_id=step.id, status=StepStatus.BLOCKED, error="command is required")
        completed = subprocess.run(
            step.command,
            cwd=context.workdir,
            shell=True,
            text=True,
            capture_output=True,
            timeout=step.timeout_sec,
            check=False,
        )
        (step_dir / "stdout.txt").write_text(completed.stdout, encoding="utf-8")
        (step_dir / "stderr.txt").write_text(completed.stderr, encoding="utf-8")
        result_path = step_dir / "result.txt"
        result_path.write_text(f"exit_code={completed.returncode}\n", encoding="utf-8")
        if completed.returncode != 0:
            return StepResult(
                step_id=step.id,
                status=StepStatus.FAILED,
                exit_code=completed.returncode,
                output_path=_relative_to_repo(result_path, context),
                error=completed.stderr.strip() or completed.stdout.strip(),
                failure_kind=FailureKind.IMPLEMENTATION,
            )
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED, exit_code=0, output_path=_relative_to_repo(result_path, context))

    def _run_git_boundary(self, step: Step, context: RunContext, step_dir: Path) -> StepResult:
        if step.command:
            return self._run_command(step, context, step_dir)
        if len(step.inputs) == 1 and len(step.outputs) == 1:
            source = context.repo_root / step.inputs[0]
            target = context.repo_root / step.outputs[0]
            if not source.exists():
                return StepResult(step_id=step.id, status=StepStatus.BLOCKED, error=f"missing source: {step.inputs[0]}")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(target))
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)
        return StepResult(step_id=step.id, status=StepStatus.BLOCKED, error="git step requires an explicit command or one input/output move")


def _relative_to_repo(path: Path | None, context: RunContext) -> Path:
    if path is None:
        return Path("-")
    try:
        return path.relative_to(context.repo_root)
    except ValueError:
        return path


def _load_agent_config(path: Path) -> Mapping[str, Any]:
    with path.open("rb") as file:
        return tomllib.load(file)


def _implementation_environment_preflight(
    step: Step,
    context: RunContext,
    step_dir: Path,
    agent_config: Mapping[str, Any],
) -> str | None:
    if step.agent_id != "implementation_executor":
        return None

    problems: list[str] = []
    gradlew = context.repo_root / "gradlew"
    sandbox_mode = str(agent_config.get("sandbox_mode", "") or "")
    if gradlew.exists() and sandbox_mode != "danger-full-access":
        problems.append(
            "Gradle wrapper detected, but implementation_executor sandbox_mode is "
            f"{sandbox_mode or '<unset>'}. Use danger-full-access so Gradle daemon "
            "and local runtime sockets can start before running implementation."
        )

    npm_path = shutil.which("npm")
    if (context.repo_root / "frontend/package.json").exists() and npm_path and npm_path.startswith("/mnt/"):
        problems.append(
            "frontend/package.json detected, but npm resolves to a Windows-mounted path: "
            f"{npm_path}. Put a Linux-native Node/npm path before /mnt paths in PATH."
        )

    payload = {
        "step_id": step.id,
        "agent_id": step.agent_id,
        "gradlew_present": gradlew.exists(),
        "sandbox_mode": sandbox_mode or None,
        "gradle_user_home": os.environ.get("GRADLE_USER_HOME"),
        "npm_path": npm_path,
        "status": "blocked" if problems else "passed",
        "problems": problems,
    }
    preflight_path = step_dir / "preflight.json"
    preflight_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if not problems:
        return None
    return "implementation environment preflight failed: " + " ".join(problems)


def _validate_agent_outputs(step: Step, context: RunContext) -> str | None:
    missing: list[str] = []
    for output in step.outputs:
        path = context.repo_root / output
        if not path.exists():
            missing.append(str(output))
    if missing:
        return "missing agent outputs: " + ", ".join(missing)

    slice_outputs = step.metadata.get("slice_outputs")
    if not isinstance(slice_outputs, Mapping):
        return None
    root_value = slice_outputs.get("root")
    required_value = slice_outputs.get("required_per_use_case")
    if not isinstance(root_value, str) or not root_value.strip():
        return None
    if not isinstance(required_value, Sequence) or isinstance(required_value, (str, bytes)):
        return None

    slice_root = context.repo_root / root_value
    uc_dirs = sorted(path for path in slice_root.glob("UC-*") if path.is_dir())
    if not uc_dirs:
        return f"missing required use-case slices under {root_value}"

    missing_slice_files: list[str] = []
    for uc_dir in uc_dirs:
        for required_name in required_value:
            if not isinstance(required_name, str) or not required_name:
                continue
            target = uc_dir / required_name
            if not target.is_file():
                missing_slice_files.append(str(target.relative_to(context.repo_root)))
    if missing_slice_files:
        return "missing required use-case slice outputs: " + ", ".join(missing_slice_files)
    return None


def _resolve_provider_command(request: AgentRunRequest, final_message_path: Path, *, default_codex_binary: str) -> tuple[list[str], dict[str, Any]] | AgentRunResult:
    config = request.agent_config
    provider = config.get("provider", "codex")
    if not isinstance(provider, str) or not provider.strip():
        return _blocked_provider_result(request, "agent provider must be a non-empty string")
    provider = provider.strip()
    if provider == "codex":
        binary = config.get("provider_binary", default_codex_binary)
        if not isinstance(binary, str) or not binary.strip():
            return _blocked_provider_result(request, "codex provider_binary must be a non-empty string", provider=provider)
        command = _codex_command(request, final_message_path, binary.strip())
        return command, {"provider": provider, "provider_command": command}
    if provider == "custom_cli":
        command = _custom_provider_command(config.get("provider_command"))
        if command is None:
            return _blocked_provider_result(request, "custom_cli provider requires provider_command as a non-empty list of strings", provider=provider)
        return command, {"provider": provider, "provider_command": command}
    return _blocked_provider_result(request, f"unsupported agent provider: {provider}", provider=provider)


def _codex_command(request: AgentRunRequest, final_message_path: Path, codex_binary: str) -> list[str]:
    config = request.agent_config
    command = [
        codex_binary,
        "exec",
        "--skip-git-repo-check",
        "--cd",
        str(request.context.workdir),
        "-c",
        'approval_policy="never"',
        "--output-last-message",
        str(final_message_path),
    ]
    model = config.get("model")
    if isinstance(model, str) and model:
        command.extend(["--model", model])
    reasoning_effort = config.get("model_reasoning_effort")
    if isinstance(reasoning_effort, str) and reasoning_effort:
        command.extend(["-c", f'model_reasoning_effort="{reasoning_effort}"'])
    sandbox_mode = config.get("sandbox_mode")
    if isinstance(sandbox_mode, str) and sandbox_mode:
        command.extend(["--sandbox", sandbox_mode])
    command.append("-")
    return command


def _custom_provider_command(value: Any) -> list[str] | None:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return None
    command = list(value)
    if not command or not all(isinstance(part, str) and part for part in command):
        return None
    return command


def _blocked_provider_result(request: AgentRunRequest, error: str, *, provider: str | None = None) -> AgentRunResult:
    return AgentRunResult(status=StepStatus.BLOCKED, error=error, metadata={"agent_id": request.step.agent_id, "provider": provider, "provider_error": error})


def _agent_metadata(request: AgentRunRequest, prompt_path: Path, final_message_path: Path, *, error: str | None = None) -> dict[str, Any]:
    run_prompt_path = request.context.run_dir / f"prompt-{request.step.id}.md"
    metadata: dict[str, Any] = {
        "agent_id": request.step.agent_id,
        "agent_config": str(_relative_to_repo(request.agent_config_path, request.context)),
        "skill_id": _step_skill_id(request.step),
        "skill_path": str(_relative_to_repo(request.skill_path, request.context)) if request.skill_path is not None else None,
        "invocation_path": str(_relative_to_repo(request.step_dir / "invocation.json", request.context)),
        "prompt_path": str(_relative_to_repo(prompt_path, request.context)),
        "run_prompt_path": str(_relative_to_repo(run_prompt_path, request.context)),
        "stdout_path": str(_relative_to_repo(request.step_dir / "stdout.txt", request.context)),
        "stderr_path": str(_relative_to_repo(request.step_dir / "stderr.txt", request.context)),
        "final_message_path": str(_relative_to_repo(final_message_path, request.context)),
    }
    if error is not None:
        metadata["adapter_error"] = error
    return metadata


def _decode_process_output(value: str | bytes | None) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode(errors="replace")
    return value


def _agent_process_blocker_error(output: str) -> str | None:
    for line in output.splitlines():
        normalized = line.lower()
        if "you've hit your usage limit" in normalized or "usage limit" in normalized:
            return line
        if "rate limit" in normalized:
            return line
    return None


def _blocked_agent_result(step: Step, context: RunContext, step_dir: Path, error: str) -> StepResult:
    result_path = step_dir / "result.json"
    result_path.write_text(
        json.dumps(
            {"step_id": step.id, "agent_id": step.agent_id, "skill_id": _step_skill_id(step), "status": StepStatus.BLOCKED.value, "error": error},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    _write_response_snapshot(context, step.id, result_path)
    return StepResult(step_id=step.id, status=StepStatus.BLOCKED, output_path=_relative_to_repo(result_path, context), error=error, failure_kind=FailureKind.ENVIRONMENT_BLOCKER, metadata={"agent_id": step.agent_id, "skill_id": _step_skill_id(step)})


def _step_skill_id(step: Step) -> str | None:
    if step.skill_id:
        return step.skill_id
    skill_id = step.metadata.get("skill_id")
    if isinstance(skill_id, str) and skill_id.strip():
        return skill_id
    return None


def _agent_invocation_manifest(step: Step, context: RunContext, agent_config_path: Path, skill_path: Path | None) -> dict[str, Any]:
    return {
        "step_id": step.id,
        "agent_id": step.agent_id,
        "agent_config": str(_relative_to_repo(agent_config_path, context)),
        "skill_id": _step_skill_id(step),
        "skill_path": str(_relative_to_repo(skill_path, context)) if skill_path is not None else None,
        "inputs": [str(path) for path in step.inputs],
        "outputs": [str(path) for path in step.outputs],
        "metadata": _jsonable(step.metadata),
    }


def _write_run_root_artifact_reference(
    request: AgentRunRequest,
    filename: str,
    target_path: Path,
) -> Path:
    path = request.context.run_dir / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"See canonical artifact: {_relative_to_run_dir(target_path, request.context.run_dir)}\n",
        encoding="utf-8",
    )
    return path


def _mirror_agent_artifacts(
    request: AgentRunRequest,
    stdout_path: Path,
    stderr_path: Path,
    final_message_path: Path | None,
    result: AgentRunResult,
) -> None:
    run_dir = request.context.run_dir
    run_dir.mkdir(parents=True, exist_ok=True)
    _write_run_root_artifact_reference(
        request,
        f"stdout-{request.step.id}.log",
        stdout_path,
    )
    _write_run_root_artifact_reference(
        request,
        f"stderr-{request.step.id}.log",
        stderr_path,
    )
    response = {
        "step_id": request.step.id,
        "status": result.status.value,
        "exit_code": result.exit_code,
        "error": result.error,
        "metadata": dict(result.metadata),
    }
    if final_message_path is not None and final_message_path.exists():
        response["final_message"] = final_message_path.read_text(encoding="utf-8")
    (run_dir / f"response-{request.step.id}.json").write_text(
        json.dumps(response, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    _write_usage_snapshot(request, result)


def _write_response_snapshot(context: RunContext, step_id: str, result_path: Path) -> None:
    if not result_path.exists():
        return
    context.run_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(result_path, context.run_dir / f"response-{step_id}.json")


def _relative_to_run_dir(path: Path, run_dir: Path) -> Path:
    try:
        return path.relative_to(run_dir)
    except ValueError:
        return path


def _write_usage_snapshot(request: AgentRunRequest, result: AgentRunResult) -> None:
    usage = result.metadata.get("usage") if isinstance(result.metadata, Mapping) else None
    usage_payload = usage if isinstance(usage, Mapping) else {}
    payload = {
        "step_id": request.step.id,
        "work_item_id": request.context.metadata.get("active_work_item_id"),
        "change_set_id": request.context.metadata.get("change_set_id"),
        "model": request.agent_config.get("model"),
        "prompt_tokens": usage_payload.get("prompt_tokens"),
        "completion_tokens": usage_payload.get("completion_tokens"),
        "cached_prompt_tokens": usage_payload.get("cached_prompt_tokens"),
    }
    path = request.context.run_dir / f"usage-{request.step.id}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _jsonable(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if hasattr(value, "value"):
        return value.value
    return value


def _agent_failure_kind(status: StepStatus) -> FailureKind | None:
    if status == StepStatus.FAILED:
        return FailureKind.IMPLEMENTATION
    if status == StepStatus.BLOCKED:
        return FailureKind.ENVIRONMENT_BLOCKER
    return None
