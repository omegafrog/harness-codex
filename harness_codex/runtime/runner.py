"""Step runner boundary for runtime execution.

`StepRunner` is the adapter boundary between the pure runtime engine and
side-effecting implementations such as Codex, shell, git, and validators.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tomllib
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol
from pathlib import Path

from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    Step,
    StepKind,
    StepResult,
    StepStatus,
)


@dataclass(frozen=True)
class AgentRunRequest:
    """Codex 전담 에이전트 호출에 필요한 입력."""

    step: Step
    context: RunContext
    step_dir: Path
    agent_config_path: Path
    agent_config: Mapping[str, Any]
    skill_path: Path | None = None
    skill_body: str | None = None


@dataclass(frozen=True)
class AgentRunResult:
    """Codex 전담 에이전트 호출 결과."""

    status: StepStatus
    exit_code: int | None = None
    error: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


class AgentAdapter(Protocol):
    """AGENT 단계 실행 adapter."""

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        """전담 에이전트를 실행하고 구조화된 결과를 반환한다."""
        ...


class StepRunner(Protocol):
    """Adapter interface used by `RunnerEngine` to execute one step.

    Implementations may call Codex, shell, git, validators, or fake test doubles.

    The engine depends only on this protocol and never performs those side
    effects directly.
    """

    def run(self, step: Step, context: RunContext) -> StepResult:
        """Execute one step and return a structured result."""
        ...


class CodexCliAgentAdapter:
    """`.codex/agents/*.toml` 설정으로 `codex exec`를 실행한다."""

    def __init__(self, codex_binary: str = "codex") -> None:
        self._codex_binary = codex_binary

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        prompt_path = request.step_dir / "prompt.md"
        final_message_path = request.step_dir / "final-message.md"
        command_path = request.step_dir / "command.json"

        prompt_path.write_text(_agent_prompt(request), encoding="utf-8")

        command = self._command(request, final_message_path)
        command_path.write_text(
            json.dumps(command, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        try:
            completed = subprocess.run(
                command,
                cwd=request.context.workdir,
                input=prompt_path.read_text(encoding="utf-8"),
                text=True,
                capture_output=True,
                timeout=request.step.timeout_sec,
                check=False,
            )
        except FileNotFoundError as exc:
            error = f"codex binary not found: {self._codex_binary}"
            (request.step_dir / "stdout.txt").write_text("", encoding="utf-8")
            (request.step_dir / "stderr.txt").write_text(error, encoding="utf-8")
            return AgentRunResult(
                status=StepStatus.BLOCKED,
                error=error,
                metadata=_agent_metadata(
                    request,
                    prompt_path,
                    final_message_path,
                    error=str(exc),
                ),
            )
        except subprocess.TimeoutExpired as exc:
            stdout = _decode_process_output(exc.stdout)
            stderr = _decode_process_output(exc.stderr)
            error = f"agent step timed out after {request.step.timeout_sec} seconds"
            (request.step_dir / "stdout.txt").write_text(stdout, encoding="utf-8")
            (request.step_dir / "stderr.txt").write_text(
                stderr or error,
                encoding="utf-8",
            )
            return AgentRunResult(
                status=StepStatus.FAILED,
                error=error,
                metadata=_agent_metadata(
                    request,
                    prompt_path,
                    final_message_path,
                    error=str(exc),
                ),
            )
        (request.step_dir / "stdout.txt").write_text(
            completed.stdout,
            encoding="utf-8",
        )
        (request.step_dir / "stderr.txt").write_text(
            completed.stderr,
            encoding="utf-8",
        )

        if completed.returncode != 0:
            return AgentRunResult(
                status=StepStatus.FAILED,
                exit_code=completed.returncode,
                error=completed.stderr.strip() or completed.stdout.strip(),
                metadata=_agent_metadata(request, prompt_path, final_message_path),
            )

        return AgentRunResult(
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            metadata=_agent_metadata(request, prompt_path, final_message_path),
        )

    def _command(
        self,
        request: AgentRunRequest,
        final_message_path: Path,
    ) -> list[str]:
        config = request.agent_config
        command = [
            self._codex_binary,
            "exec",
            "--cd",
            str(request.context.workdir),
            "--ask-for-approval",
            "never",
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


class BasicStepRunner:
    """Local MVP adapter for record/shell/validator/git steps."""

    def __init__(self, agent_adapter: AgentAdapter | None = None) -> None:
        self._agent_adapter = agent_adapter or CodexCliAgentAdapter()

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

    def _run_agent(
        self,
        step: Step,
        context: RunContext,
        step_dir: Path,
    ) -> StepResult:
        if not step.agent_id:
            return _blocked_agent_result(
                step,
                context,
                step_dir,
                "agent_id is required",
            )

        agent_config_path = context.repo_root / ".codex/agents" / f"{step.agent_id}.toml"
        if not agent_config_path.exists():
            return _blocked_agent_result(
                step,
                context,
                step_dir,
                f"missing agent config: {_relative_to_repo(agent_config_path, context)}",
            )

        agent_config = _load_agent_config(agent_config_path)
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
                _agent_invocation_manifest(
                    step,
                    context,
                    agent_config_path,
                    skill_path,
                ),
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
        return StepResult(
            step_id=step.id,
            status=result.status,
            exit_code=result.exit_code,
            output_path=_relative_to_repo(result_path, context),
            error=result.error,
            failure_kind=_agent_failure_kind(result.status),
            metadata=result.metadata,
        )

    def _run_record(
        self,
        step: Step,
        context: RunContext,
        step_dir: Path,
    ) -> StepResult:
        missing = tuple(
            path for path in step.inputs if not (context.repo_root / path).exists()
        )
        evidence = step_dir / "record.json"
        evidence.write_text(
            "{\n"
            f'  "step_id": "{step.id}",\n'
            f'  "missing_inputs": {[str(path) for path in missing]}\n'
            "}\n",
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
        return StepResult(
            step_id=step.id,
            status=StepStatus.SUCCEEDED,
            output_path=_relative_to_repo(evidence, context),
        )

    def _run_command(
        self,
        step: Step,
        context: RunContext,
        step_dir: Path,
    ) -> StepResult:
        if not step.command:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error="command is required",
            )

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
        result_path.write_text(
            f"exit_code={completed.returncode}\n",
            encoding="utf-8",
        )
        if completed.returncode != 0:
            return StepResult(
                step_id=step.id,
                status=StepStatus.FAILED,
                exit_code=completed.returncode,
                output_path=_relative_to_repo(result_path, context),
                error=completed.stderr.strip() or completed.stdout.strip(),
                failure_kind=FailureKind.IMPLEMENTATION,
            )
        return StepResult(
            step_id=step.id,
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            output_path=_relative_to_repo(result_path, context),
        )

    def _run_git_boundary(
        self,
        step: Step,
        context: RunContext,
        step_dir: Path,
    ) -> StepResult:
        if step.command:
            return self._run_command(step, context, step_dir)

        if len(step.inputs) == 1 and len(step.outputs) == 1:
            source = context.repo_root / step.inputs[0]
            target = context.repo_root / step.outputs[0]
            if not source.exists():
                return StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error=f"missing source: {step.inputs[0]}",
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(target))
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)

        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            error="git step requires an explicit command or one input/output move",
        )


def _relative_to_repo(path: Path, context: RunContext) -> Path:
    try:
        return path.relative_to(context.repo_root)
    except ValueError:
        return path


def _load_agent_config(path: Path) -> Mapping[str, Any]:
    with path.open("rb") as file:
        return tomllib.load(file)


def _agent_metadata(
    request: AgentRunRequest,
    prompt_path: Path,
    final_message_path: Path,
    *,
    error: str | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {
        "agent_id": request.step.agent_id,
        "agent_config": str(
            _relative_to_repo(request.agent_config_path, request.context)
        ),
        "skill_id": _step_skill_id(request.step),
        "skill_path": (
            str(_relative_to_repo(request.skill_path, request.context))
            if request.skill_path is not None
            else None
        ),
        "invocation_path": str(
            _relative_to_repo(request.step_dir / "invocation.json", request.context)
        ),
        "prompt_path": str(_relative_to_repo(prompt_path, request.context)),
        "stdout_path": str(
            _relative_to_repo(request.step_dir / "stdout.txt", request.context)
        ),
        "stderr_path": str(
            _relative_to_repo(request.step_dir / "stderr.txt", request.context)
        ),
        "final_message_path": str(
            _relative_to_repo(final_message_path, request.context)
        ),
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


def _blocked_agent_result(
    step: Step,
    context: RunContext,
    step_dir: Path,
    error: str,
) -> StepResult:
    result_path = step_dir / "result.json"
    result_path.write_text(
        json.dumps(
            {
                "step_id": step.id,
                "agent_id": step.agent_id,
                "skill_id": _step_skill_id(step),
                "status": StepStatus.BLOCKED.value,
                "error": error,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return StepResult(
        step_id=step.id,
        status=StepStatus.BLOCKED,
        output_path=_relative_to_repo(result_path, context),
        error=error,
        failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
        metadata={"agent_id": step.agent_id, "skill_id": _step_skill_id(step)},
    )


def _agent_prompt(request: AgentRunRequest) -> str:
    config = request.agent_config
    instructions = config.get("developer_instructions", "")
    context_metadata = json.dumps(
        _jsonable(request.context.metadata),
        ensure_ascii=False,
        indent=2,
    )
    step_metadata = json.dumps(
        _jsonable(request.step.metadata),
        ensure_ascii=False,
        indent=2,
    )
    inputs = "\n".join(f"- `{path}`" for path in request.step.inputs) or "- 없음"
    outputs = "\n".join(f"- `{path}`" for path in request.step.outputs) or "- 없음"
    skill_lines = _agent_prompt_skill_lines(request)

    return "\n".join(
        [
            f"# Harness Agent Step: {request.step.id}",
            "",
            "아래 전담 에이전트 지시문을 기준으로 이 런타임 단계를 수행한다.",
            "",
            "## Agent",
            f"- ID: `{request.step.agent_id}`",
            f"- Name: `{config.get('name', request.step.agent_id)}`",
            f"- Description: {config.get('description', '')}",
            "",
            *skill_lines,
            "",
            "## Developer Instructions",
            str(instructions).strip(),
            "",
            "## Runtime Context",
            f"- Run ID: `{request.context.run_id}`",
            f"- Workflow: `{request.context.workflow_name}`",
            f"- Step: `{request.step.id}`",
            f"- Step name: {request.step.name}",
            f"- Repository root: `{request.context.repo_root}`",
            f"- Workdir: `{request.context.workdir}`",
            f"- Run dir: `{request.context.run_dir}`",
            "",
            "## Step Inputs",
            inputs,
            "",
            "## Step Outputs",
            outputs,
            "",
            "## Step Metadata",
            "```json",
            step_metadata,
            "```",
            "",
            "## Workflow Metadata",
            "```json",
            context_metadata,
            "```",
            "",
            "완료 후 실제로 수행한 작업, 변경한 파일, 실행한 검증 명령, 남은 blocker를 간결하게 보고한다.",
        ]
    )


def _step_skill_id(step: Step) -> str | None:
    if step.skill_id:
        return step.skill_id

    skill_id = step.metadata.get("skill_id")
    if isinstance(skill_id, str) and skill_id.strip():
        return skill_id

    return None


def _agent_invocation_manifest(
    step: Step,
    context: RunContext,
    agent_config_path: Path,
    skill_path: Path | None,
) -> dict[str, Any]:
    return {
        "step_id": step.id,
        "agent_id": step.agent_id,
        "agent_config": str(_relative_to_repo(agent_config_path, context)),
        "skill_id": _step_skill_id(step),
        "skill_path": (
            str(_relative_to_repo(skill_path, context))
            if skill_path is not None
            else None
        ),
        "inputs": [str(path) for path in step.inputs],
        "outputs": [str(path) for path in step.outputs],
        "metadata": _jsonable(step.metadata),
    }


def _agent_prompt_skill_lines(request: AgentRunRequest) -> list[str]:
    skill_id = _step_skill_id(request.step)
    if skill_id is None:
        return [
            "## Skill",
            "- ID: `-`",
            "- Path: `-`",
        ]

    lines = [
        "## Skill",
        f"- ID: `{skill_id}`",
        f"- Path: `{_relative_to_repo(request.skill_path, request.context)}`",
        "",
        "### Skill Instructions",
        "```markdown",
        (request.skill_body or "").strip(),
        "```",
    ]
    return lines


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
