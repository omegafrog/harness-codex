"""Step runner boundary for runtime execution."""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import shlex
import subprocess
import time
import tomllib
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Mapping, Protocol, Sequence

from harness_codex.runtime.completion import (
    ChangeSetCompletionBlocked,
    PlanCompletionBlocked,
    complete_change_set_if_ready,
    validate_plan_completion,
)
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.changes.models import AffectedWorkItem, WorkItemType
from harness_codex.runtime.contract_validators import (
    validate_technical_decision_plan_coverage,
    validate_use_case_e2e_alignment,
)
from harness_codex.runtime.models import (
    ContractValidationResult,
    ContractValidationStatus,
    FailureKind,
    RunContext,
    Step,
    StepKind,
    StepResult,
    StepStatus,
)
from harness_codex.runtime.plan_mutation_guard import (
    plan_mutation_request_for_context,
    validate_plan_mutation,
    write_plan_mutation_request,
)
from harness_codex.runtime.document_metadata import ensure_generated_document_metadata
from harness_codex.runtime.prompt import build_agent_prompt
from harness_codex.runtime.token_observability import execution_fingerprint, prompt_metrics
from harness_codex.runtime.rollback import (
    capture_pre_step_snapshot,
    write_rollback_report,
)
from harness_codex.runtime.validate_scope_diff import (
    ScopePattern,
    capture_git_snapshot,
    validate_scope_diff,
    write_snapshot,
)


SUCCESS_STDERR_TAIL_BYTES = 16_384
IMPLEMENTATION_ATTEMPT_SCHEMA_VERSION = 1
IMPLEMENTATION_CHECKPOINT_SCHEMA_VERSION = 1
AGENT_TMUX_ENV = "HARNESS_AGENT_TMUX"
LOCAL_REVIEWER_ENV = "HARNESS_LOCAL_REVIEWER"
LOCAL_REVIEWER_MODEL_ENV = "HARNESS_LOCAL_REVIEWER_MODEL"
LOCAL_REVIEWER_BINARY_ENV = "HARNESS_LOCAL_REVIEWER_BINARY"
DEFAULT_LOCAL_REVIEWER_MODEL = "qwen3.5:9b"


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
    prompt_suffix: str = ""
    resume_session_id: str | None = None


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
        if request.prompt_suffix:
            prompt = f"{prompt.rstrip()}\n\n{request.prompt_suffix.strip()}\n"
        attempt = _implementation_attempt(request)
        if attempt["execution_mode"] == "resumed":
            checkpoint = attempt.get("previous_checkpoint")
            if isinstance(checkpoint, Mapping):
                checkpoint_prompt = _compact_checkpoint_for_prompt(
                    checkpoint,
                    checkpoint_path=attempt.get("previous_checkpoint_path"),
                )
                prompt = (
                    f"{prompt.rstrip()}\n\n"
                    "## Durable implementation checkpoint\n\n"
                    f"{json.dumps(checkpoint_prompt, ensure_ascii=False, indent=2)}\n"
                )
        prompt_path.write_text(prompt, encoding="utf-8")
        _write_run_root_artifact_reference(
            request,
            f"prompt-{request.step.id}.md",
            prompt_path,
        )

        provider_request = replace(request, resume_session_id=None)
        provider_result = _resolve_provider_command(
            provider_request,
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
        provider_metadata = {
            **provider_metadata,
            "execution_mode": attempt["execution_mode"],
            "attempt": attempt["attempt"],
            "prompt_metrics": prompt_metrics(prompt),
            "checkpoint_path": str(
                _relative_to_repo(request.step_dir / "checkpoint.json", request.context)
            ),
        }
        provider_metadata["input_fingerprint"] = execution_fingerprint(
            prompt=prompt,
            command=command,
            provider=str(provider_metadata.get("provider") or ""),
        )
        command_path.write_text(
            json.dumps(command, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        stdout_path = request.step_dir / "stdout.txt"
        stderr_path = request.step_dir / "stderr.txt"
        try:
            completed = _run_agent_provider_process(
                request=request,
                command=command,
                prompt=_provider_prompt(prompt, provider_metadata),
                stdout_path=stdout_path,
                stderr_path=stderr_path,
                provider_metadata=provider_metadata,
            )
        except FileNotFoundError as exc:
            binary = command[0] if command else "<empty>"
            provider = provider_metadata["provider"]
            error = f"agent provider binary not found: provider={provider} binary={binary}"
            stdout_path.write_text("", encoding="utf-8")
            stderr_path.write_text(error, encoding="utf-8")
            result = AgentRunResult(
                status=StepStatus.BLOCKED,
                error=error,
                metadata={
                    **_agent_metadata(request, prompt_path, final_message_path, error=str(exc)),
                    **provider_metadata,
                    "termination_reason": "provider_not_found",
                },
            )
            checkpoint = _write_implementation_attempt_and_checkpoint(
                request,
                attempt=attempt,
                provider_metadata=provider_metadata,
                stdout="",
                termination_reason="provider_not_found",
                status="blocked",
            )
            result = _with_implementation_checkpoint_metadata(result, checkpoint)
            _mirror_agent_artifacts(request, stdout_path, stderr_path, None, result)
            return result
        except subprocess.TimeoutExpired as exc:
            stdout = _decode_process_output(exc.stdout) or _read_text_if_exists(stdout_path)
            stderr = _decode_process_output(exc.stderr) or _read_text_if_exists(stderr_path)
            error = f"agent step timed out after {request.step.timeout_sec} seconds"
            stdout_path.write_text(stdout, encoding="utf-8")
            stderr_path.write_text(stderr or error, encoding="utf-8")
            result = AgentRunResult(
                status=StepStatus.FAILED,
                error=error,
                metadata={
                    **_agent_metadata(request, prompt_path, final_message_path, error=str(exc)),
                    **provider_metadata,
                    "termination_reason": "timeout",
                },
            )
            provider_session_id = _codex_session_id(stdout)
            if provider_session_id:
                result = AgentRunResult(
                    status=result.status,
                    exit_code=result.exit_code,
                    error=result.error,
                    metadata={**result.metadata, "provider_session_id": provider_session_id},
                )
            checkpoint = _write_implementation_attempt_and_checkpoint(
                request,
                attempt=attempt,
                provider_metadata=result.metadata,
                stdout=stdout,
                termination_reason="timeout",
                status="failed",
            )
            result = _with_implementation_checkpoint_metadata(result, checkpoint)
            _mirror_agent_artifacts(request, stdout_path, stderr_path, None, result)
            return result

        stdout = (
            completed.stdout
            if isinstance(completed.stdout, str)
            else _read_text_if_exists(stdout_path)
        )
        if not stdout:
            stdout = _read_text_if_exists(stdout_path)
        stderr = (
            completed.stderr
            if isinstance(completed.stderr, str)
            else _read_text_if_exists(stderr_path)
        )
        stdout_path.write_text(stdout, encoding="utf-8")
        provider_session_id = _codex_session_id(stdout)
        if provider_session_id:
            provider_metadata = {
                **provider_metadata,
                "provider_session_id": provider_session_id,
            }
        if _stdout_backed_provider(str(provider_metadata["provider"])):
            final_message_path.write_text(stdout, encoding="utf-8")

        if completed.returncode != 0:
            stderr_path.write_text(stderr, encoding="utf-8")
            error = stderr.strip() or stdout.strip()
            blocker = _agent_process_blocker_error(error)
            status = StepStatus.BLOCKED if blocker is not None else StepStatus.FAILED
            result = AgentRunResult(
                status=status,
                exit_code=completed.returncode,
                error=blocker or error,
                metadata={
                    **_agent_metadata(request, prompt_path, final_message_path),
                    **provider_metadata,
                    "termination_reason": "process_error",
                },
            )
            checkpoint = _write_implementation_attempt_and_checkpoint(
                request,
                attempt=attempt,
                provider_metadata=result.metadata,
                stdout=stdout,
                termination_reason="process_error",
                status=status.value,
            )
            result = _with_implementation_checkpoint_metadata(result, checkpoint)
            _mirror_agent_artifacts(request, stdout_path, stderr_path, final_message_path, result)
            return result

        _write_stdout_backed_outputs(request, stdout, provider=str(provider_metadata["provider"]))
        stderr_path.write_text(_successful_stderr_artifact(stderr), encoding="utf-8")
        result = AgentRunResult(
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            metadata={
                **_agent_metadata(request, prompt_path, final_message_path),
                **provider_metadata,
                "termination_reason": "completed",
            },
        )
        checkpoint = _write_implementation_attempt_and_checkpoint(
            request,
            attempt=attempt,
            provider_metadata=result.metadata,
            stdout=stdout,
            termination_reason="completed",
            status="succeeded",
        )
        result = _with_implementation_checkpoint_metadata(result, checkpoint)
        _mirror_agent_artifacts(request, stdout_path, stderr_path, final_message_path, result)
        return result


class CodexCliAgentAdapter(ConfigurableCliAgentAdapter):
    """Backward-compatible Codex adapter name."""


@dataclass(frozen=True)
class _ProviderCompleted:
    returncode: int
    stdout: str = ""
    stderr: str = ""
    metadata: Mapping[str, Any] = field(default_factory=dict)


class BasicStepRunner:
    """Local MVP adapter for record/shell/validator/git steps."""

    def __init__(self, agent_adapter: AgentAdapter | None = None) -> None:
        self._agent_adapter = agent_adapter or ConfigurableCliAgentAdapter()

    def run(self, step: Step, context: RunContext) -> StepResult:
        step_dir = context.run_dir / "steps" / step.id
        step_dir.mkdir(parents=True, exist_ok=True)

        if step.kind is StepKind.AGENT:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error="agent steps belong to the orchestration agent, not runtime execution",
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                metadata={
                    "runtime_contract": "agent-step-not-executed",
                    "orchestration_owner": "orchestration-agent",
                },
            )

        if step.metadata.get("run_on_final_work_item_only") and not context.metadata.get(
            "is_final_work_item"
        ):
            return StepResult(
                step_id=step.id,
                status=StepStatus.SKIPPED,
                metadata={"reason": "step runs only for the final work item"},
            )

        snapshot = (
            capture_pre_step_snapshot(context, step)
            if _requires_rollback_snapshot(step)
            else None
        )

        if step.kind == StepKind.RECORD:
            result = self._run_record(step, context, step_dir)
        elif step.kind in {StepKind.SHELL, StepKind.VALIDATOR}:
            result = self._run_command(step, context, step_dir)
        elif step.kind == StepKind.GIT:
            result = self._run_git_boundary(step, context, step_dir)
        elif step.kind == StepKind.DECISION:
            result = self._run_decision(step, context, step_dir)
        else:
            result = StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error=f"unsupported step kind: {step.kind.value}",
            )

        if snapshot is not None and result.status in {StepStatus.FAILED, StepStatus.BLOCKED}:
            report_path = write_rollback_report(context, step, result, snapshot)
            return replace(
                result,
                metadata={
                    **dict(result.metadata),
                    "rollback_report_path": str(_relative_to_repo(report_path, context)),
                    "rollback_snapshot_path": str(
                        _relative_to_repo(snapshot.snapshot_dir, context)
                    ),
                },
            )
        return result

    def _run_decision(self, step: Step, context: RunContext, step_dir: Path) -> StepResult:
        error = "decision steps belong to the orchestration agent, not runtime execution"
        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            error=error,
            failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
            metadata={"runtime_contract": "decision-step-not-executed", "orchestration_owner": "orchestration-agent"},
        )

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

        input_preflight_error = _agent_input_preflight(step, context, step_dir)
        if input_preflight_error is not None:
            return _blocked_agent_result(step, context, step_dir, input_preflight_error)

        agent_config = _load_agent_config(agent_config_path)
        preflight_error = _implementation_environment_preflight(step, context, step_dir, agent_config)
        if preflight_error is not None:
            return _blocked_agent_result(step, context, step_dir, preflight_error)

        contract_error = _semantic_contract_preflight(step, context)
        if contract_error is not None:
            return _blocked_agent_result(step, context, step_dir, contract_error)

        skill_id = _step_skill_id(step)
        skill_path: Path | None = None
        if skill_id is not None:
            skill_path = context.repo_root / ".codex/skills" / skill_id / "SKILL.md"
            if not skill_path.exists():
                return _blocked_agent_result(
                    step,
                    context,
                    step_dir,
                    f"missing skill config: {_relative_to_repo(skill_path, context)}",
                )

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
        review_input_hash = _review_input_hash(step, context, agent_config_path, skill_path)
        cached_review = _restore_cached_review(step, context, step_dir, review_input_hash)
        if cached_review is not None:
            return cached_review
        plan_mutation_request = plan_mutation_request_for_context(context) if _is_plan_work_item_step(step) else None
        plan_mutation_before = _read_plan_output(step, context) if plan_mutation_request else None
        plan_mutation_request_path = (
            write_plan_mutation_request(context=context, step=step, request=plan_mutation_request)
            if plan_mutation_request
            else None
        )
        scope_before = None
        if _requires_scope_diff_validation(step):
            scope_before = capture_git_snapshot(context.repo_root)
            write_snapshot(step_dir / "scope-diff-before.json", scope_before)

        result = self._agent_adapter.run(
            AgentRunRequest(
                step=step,
                context=context,
                step_dir=step_dir,
                agent_config_path=agent_config_path,
                agent_config=agent_config,
                skill_path=skill_path,
                prompt_suffix="\n\n".join(
                    part
                    for part in (
                        _planner_product_scope_prompt_suffix(step),
                        _implementation_completion_prompt_suffix(step, context),
                        _local_reviewer_prompt_suffix(step, context),
                        _plan_mutation_prompt_suffix(
                            request_path=plan_mutation_request_path,
                            context=context,
                        ),
                    )
                    if part
                ),
            )
        )
        if _requires_scope_diff_validation(step) and scope_before is not None:
            scope_after = capture_git_snapshot(context.repo_root)
            write_snapshot(step_dir / "scope-diff-after.json", scope_after)
            scope_result = validate_scope_diff(
                repo_root=context.repo_root,
                run_id=context.run_id,
                change_set_id=_context_string(context, "change_set_id") or "",
                work_item_id=_context_string(context, "active_work_item_id") or "",
                before=scope_before,
                after=scope_after,
                report_path=step_dir / "scope-diff-report.json",
                context_metadata={**dict(context.metadata), "workflow_name": context.workflow_name},
                runtime_allow_patterns=_runtime_scope_allow_patterns(context, step_dir),
            )
            result = AgentRunResult(
                status=(
                    StepStatus.BLOCKED
                    if result.status == StepStatus.SUCCEEDED
                    and scope_result.blocked_files
                    else result.status
                ),
                exit_code=result.exit_code,
                error=(
                    scope_result.message
                    if result.status == StepStatus.SUCCEEDED
                    and scope_result.blocked_files
                    else result.error
                ),
                metadata={
                    **dict(result.metadata),
                    "scope_diff_status": scope_result.status,
                    "scope_diff_report_path": str(
                        _relative_to_repo(scope_result.report_path, context)
                    ),
                    "scope_diff_blocked_files": scope_result.blocked_files,
                },
            )
        if (
            result.status == StepStatus.SUCCEEDED
            and plan_mutation_request
            and plan_mutation_before is not None
        ):
            plan_mutation_after = _read_plan_output(step, context)
            guard_result = validate_plan_mutation(
                before=plan_mutation_before,
                after=plan_mutation_after or "",
                request=plan_mutation_request,
            )
            report_path = step_dir / "plan-mutation-guard.json"
            report_path.write_text(
                json.dumps(guard_result.report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            if not guard_result.passed:
                result = AgentRunResult(
                    status=StepStatus.BLOCKED,
                    exit_code=result.exit_code,
                    error=guard_result.message,
                    metadata={
                        **dict(result.metadata),
                        "plan_mutation_guard_status": "blocked",
                        "plan_mutation_guard_report": str(_relative_to_repo(report_path, context)),
                        "plan_mutation_request": str(_relative_to_repo(plan_mutation_request_path, context))
                        if plan_mutation_request_path
                        else "",
                    },
                )
            else:
                result = AgentRunResult(
                    status=result.status,
                    exit_code=result.exit_code,
                    error=result.error,
                    metadata={
                        **dict(result.metadata),
                        "plan_mutation_guard_status": "passed",
                        "plan_mutation_guard_report": str(_relative_to_repo(report_path, context)),
                        "plan_mutation_request": str(_relative_to_repo(plan_mutation_request_path, context))
                        if plan_mutation_request_path
                        else "",
                    },
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
            else:
                review_gate_error = _validate_review_gate(step, context)
                if review_gate_error:
                    result = AgentRunResult(
                        status=StepStatus.BLOCKED,
                        exit_code=result.exit_code,
                        error=review_gate_error,
                        metadata={
                            **dict(result.metadata),
                            "review_gate_status": "blocked",
                            "review_gate_error": review_gate_error,
                        },
                    )
                else:
                    _update_generated_output_contracts(step, context)
                    _store_cached_review(step, context, review_input_hash)
        if review_input_hash:
            result = AgentRunResult(
                status=result.status,
                exit_code=result.exit_code,
                error=result.error,
                metadata={
                    **dict(result.metadata),
                    "review_cache_hit": False,
                    "input_hash": review_input_hash,
                    "reviewer_usage": _reviewer_usage_metadata(result.metadata, cache_hit=False),
                },
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
            failure_kind=_agent_failure_kind(result.status, result.metadata, result.error),
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
        command = step.command
        if step.id == "verify-work-item" and context.metadata.get("force_verification"):
            command = f"{command} --force-verification"
        completed = subprocess.run(
            command,
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
        if step.id == "create-change-set-pr":
            return _create_change_set_pull_request(step, context, step_dir)
        if len(step.inputs) == 1 and len(step.outputs) == 1:
            if _is_change_set_completion_move(step.inputs[0], step.outputs[0]):
                return _complete_change_set_boundary(step, context)
            source = context.repo_root / step.inputs[0]
            target = context.repo_root / step.outputs[0]
            if not source.exists():
                return StepResult(step_id=step.id, status=StepStatus.BLOCKED, error=f"missing source: {step.inputs[0]}")
            if _is_plan_completion_move(step.inputs[0], step.outputs[0]):
                contract_error = _plan_completion_contract_error(context, step.inputs[0])
                if contract_error is not None:
                    return StepResult(
                        step_id=step.id,
                        status=StepStatus.BLOCKED,
                        error=f"plan completion blocked: {contract_error}",
                        failure_kind=FailureKind.IMPLEMENTATION,
                    )
                try:
                    validate_plan_completion(
                        context.repo_root,
                        step.inputs[0],
                        run_id=context.run_id,
                        change_set_id=_context_string(context, "change_set_id"),
                        work_item_id=_work_item_id_from_plan_path(step.inputs[0]),
                    )
                except PlanCompletionBlocked as exc:
                    return StepResult(
                        step_id=step.id,
                        status=StepStatus.BLOCKED,
                        error=f"plan completion blocked: {exc.reason}",
                        failure_kind=FailureKind.IMPLEMENTATION,
                    )
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(target))
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)
        return StepResult(step_id=step.id, status=StepStatus.BLOCKED, error="git step requires an explicit command or one input/output move")


def _complete_change_set_boundary(step: Step, context: RunContext) -> StepResult:
    change_set_path = context.repo_root / step.inputs[0]
    if not change_set_path.exists():
        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            error=f"missing source: {step.inputs[0]}",
        )

    change_set = parse_changeset_markdown(
        change_set_path.read_text(encoding="utf-8"),
        path=step.inputs[0],
    )
    try:
        completion = complete_change_set_if_ready(
            context.repo_root,
            change_set,
            run_id=context.run_id,
        )
    except ChangeSetCompletionBlocked as exc:
        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            error=f"ChangeSet completion blocked: {exc.reason}",
        )

    delivery_error = _publish_change_set_completion(context, change_set.change_set_id)
    if delivery_error:
        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            output_path=completion.report_path,
            error=f"ChangeSet completion delivery blocked: {delivery_error}",
            failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
        )

    return StepResult(
        step_id=step.id,
        status=StepStatus.SUCCEEDED,
        output_path=completion.report_path,
        metadata={
            "completed_path": str(completion.completed_path),
            "completed_work_items": list(completion.completed_work_items),
            "already_completed": completion.already_completed,
            "completion_published": True,
        },
    )


def _publish_change_set_completion(context: RunContext, change_set_id: str) -> str | None:
    status = _run_git_command(context.repo_root, "status", "--porcelain")
    if status.returncode != 0:
        return status.stderr.strip() or status.stdout.strip()
    if status.stdout.strip():
        added = _run_git_command(context.repo_root, "add", "-A")
        if added.returncode != 0:
            return added.stderr.strip() or added.stdout.strip()
        staged = _run_git_command(context.repo_root, "diff", "--cached", "--quiet")
        if staged.returncode not in {0, 1}:
            return staged.stderr.strip() or staged.stdout.strip()
        if staged.returncode == 1:
            committed = _run_git_command(
                context.repo_root,
                "commit",
                "-m",
                f"{change_set_id} ChangeSet completion",
            )
            if committed.returncode != 0:
                return committed.stderr.strip() or committed.stdout.strip()
    pushed = _run_git_command(context.repo_root, "push", "origin", "HEAD")
    if pushed.returncode != 0:
        return pushed.stderr.strip() or pushed.stdout.strip()
    return None


def _create_change_set_pull_request(
    step: Step,
    context: RunContext,
    step_dir: Path,
) -> StepResult:
    change_set_id = _context_string(context, "change_set_id")
    if not change_set_id:
        return _blocked_pr_result(step, context, step_dir, "change_set_id metadata is required")
    if shutil.which("gh") is None:
        return _blocked_pr_result(
            step,
            context,
            step_dir,
            "GitHub CLI `gh` is required to create ChangeSet PR",
        )

    repo_check = _run_git_command(
        context.repo_root,
        "rev-parse",
        "--is-inside-work-tree",
    )
    if repo_check.returncode != 0 or repo_check.stdout.strip() != "true":
        return _blocked_pr_result(
            step,
            context,
            step_dir,
            "target repo is not a git worktree",
        )

    branch = _git_stdout(context.repo_root, "branch", "--show-current")
    if not branch:
        return _blocked_pr_result(
            step,
            context,
            step_dir,
            "target repo has no current branch",
        )

    remote_check = _run_git_command(context.repo_root, "remote", "get-url", "origin")
    if remote_check.returncode != 0 or not remote_check.stdout.strip():
        return _blocked_pr_result(
            step,
            context,
            step_dir,
            "target repo has no origin remote",
        )

    base_branch = _default_base_branch(context.repo_root)
    if branch == base_branch:
        return _blocked_pr_result(
            step,
            context,
            step_dir,
            f"current branch `{branch}` is the PR base branch",
        )
    status = _run_git_command(context.repo_root, "status", "--porcelain")
    if status.returncode != 0:
        return _blocked_pr_result(
            step,
            context,
            step_dir,
            status.stderr.strip() or status.stdout.strip(),
        )
    if status.stdout.strip():
        add_result = _run_git_command(context.repo_root, "add", "-A")
        if add_result.returncode != 0:
            return _blocked_pr_result(
                step,
                context,
                step_dir,
                add_result.stderr.strip() or add_result.stdout.strip(),
            )

        staged = _run_git_command(context.repo_root, "diff", "--cached", "--quiet")
        if staged.returncode == 0:
            return _blocked_pr_result(
                step,
                context,
                step_dir,
                "no staged ChangeSet changes to commit",
            )
        if staged.returncode not in {0, 1}:
            return _blocked_pr_result(
                step,
                context,
                step_dir,
                staged.stderr.strip() or staged.stdout.strip(),
            )

        commit_message = f"{change_set_id} 변경사항 완료"
        commit_result = _run_git_command(
            context.repo_root,
            "commit",
            "-m",
            commit_message,
        )
        if commit_result.returncode != 0:
            return _blocked_pr_result(
                step,
                context,
                step_dir,
                commit_result.stderr.strip() or commit_result.stdout.strip(),
            )

    push_result = _run_git_command(context.repo_root, "push", "-u", "origin", "HEAD")
    if push_result.returncode != 0:
        return _blocked_pr_result(
            step,
            context,
            step_dir,
            push_result.stderr.strip() or push_result.stdout.strip(),
        )

    existing = _run_command_capture(
        context.repo_root,
        "gh",
        "pr",
        "view",
        "--json",
        "url,number,title",
    )
    if existing.returncode == 0:
        return _succeeded_pr_result(
            step,
            context,
            step_dir,
            existing.stdout,
            already_exists=True,
        )

    title = f"{change_set_id} ChangeSet delivery"
    body = _change_set_pr_body(change_set_id, context)
    create_result = _run_command_capture(
        context.repo_root,
        "gh",
        "pr",
        "create",
        "--base",
        base_branch,
        "--head",
        branch,
        "--title",
        title,
        "--body",
        body,
    )
    if create_result.returncode != 0:
        existing = _run_command_capture(
            context.repo_root,
            "gh",
            "pr",
            "view",
            "--json",
            "url,number,title",
        )
        if existing.returncode == 0:
            return _succeeded_pr_result(
                step,
                context,
                step_dir,
                existing.stdout,
                already_exists=True,
            )
        return _blocked_pr_result(
            step,
            context,
            step_dir,
            create_result.stderr.strip() or create_result.stdout.strip(),
        )
    return _succeeded_pr_result(
        step,
        context,
        step_dir,
        create_result.stdout,
        already_exists=False,
    )


def _run_git_command(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return _run_command_capture(repo_root, "git", *args)


def _run_command_capture(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )


def _git_stdout(repo_root: Path, *args: str) -> str:
    completed = _run_git_command(repo_root, *args)
    if completed.returncode != 0:
        return ""
    return completed.stdout.strip()


def _default_base_branch(repo_root: Path) -> str:
    remote_head = _git_stdout(
        repo_root,
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
        "--short",
    )
    if remote_head.startswith("origin/"):
        return remote_head.split("/", 1)[1]
    remote_head = _git_stdout(repo_root, "rev-parse", "--abbrev-ref", "origin/HEAD")
    if remote_head.startswith("origin/"):
        return remote_head.split("/", 1)[1]
    return "main"


def _change_set_pr_body(change_set_id: str, context: RunContext) -> str:
    run_id = context.run_id
    return "\n".join(
        [
            "## 구현 의도",
            "",
            f"- ChangeSet `{change_set_id}` 산출물을 최종 게이트 통과 후 PR로 제출합니다.",
            "",
            "## 구현 접근",
            "",
            "- harness runtime workflow가 생성한 변경사항을 현재 대상 저장소 브랜치에 커밋했습니다.",
            "- 완료된 ChangeSet 문서와 검증 산출물을 PR 증거로 포함합니다.",
            "",
            "## 검증 방법",
            "",
            f"- harness runtime run `{run_id}`의 최종 게이트 통과 후 생성되었습니다.",
            "",
            "## 위험 및 롤백",
            "",
            "- 위험: 대상 저장소의 브랜치/원격/GitHub CLI 상태에 따라 PR 생성이 차단될 수 있습니다.",
            "- 롤백: PR 브랜치의 커밋을 revert하거나 브랜치를 삭제합니다.",
            "",
        ]
    )


def _succeeded_pr_result(
    step: Step,
    context: RunContext,
    step_dir: Path,
    stdout: str,
    *,
    already_exists: bool,
) -> StepResult:
    url = _extract_pr_url(stdout)
    if not url:
        return _blocked_pr_result(
            step,
            context,
            step_dir,
            "GitHub PR command completed without a PR URL",
        )
    payload = {
        "step_id": step.id,
        "status": "succeeded",
        "change_set_id": _context_string(context, "change_set_id"),
        "url": url,
        "already_exists": already_exists,
        "stdout": stdout.strip(),
    }
    output = step_dir / "pull-request.json"
    output.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return StepResult(
        step_id=step.id,
        status=StepStatus.SUCCEEDED,
        output_path=_relative_to_repo(output, context),
        metadata={"pull_request_url": url, "already_exists": already_exists},
    )


def _blocked_pr_result(
    step: Step,
    context: RunContext,
    step_dir: Path,
    error: str,
) -> StepResult:
    output = step_dir / "pull-request.json"
    output.write_text(
        json.dumps(
            {
                "step_id": step.id,
                "status": "blocked",
                "change_set_id": _context_string(context, "change_set_id"),
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
        output_path=_relative_to_repo(output, context),
        error=f"ChangeSet PR creation blocked: {error}",
        failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
    )


def _extract_pr_url(stdout: str) -> str:
    stripped = stdout.strip()
    if not stripped:
        return ""
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        for token in stripped.split():
            if token.startswith("https://") and "/pull/" in token:
                return token
        return stripped.splitlines()[-1]
    if isinstance(data, dict):
        return str(data.get("url") or "")
    return ""


def _relative_to_repo(path: Path | None, context: RunContext) -> Path:
    if path is None:
        return Path("-")
    try:
        return path.relative_to(context.repo_root)
    except ValueError:
        return path


def _is_plan_completion_move(source: Path, target: Path) -> bool:
    return (
        len(source.parts) == 5
        and len(target.parts) == 5
        and source.parts[:3] == ("docs", "plans", "active")
        and target.parts[:3] == ("docs", "plans", "completed")
        and source.parts[3] == target.parts[3]
        and source.name == "plan.md"
        and target.name == "plan.md"
    )


def _is_change_set_completion_move(source: Path, target: Path) -> bool:
    return (
        len(source.parts) == 4
        and len(target.parts) == 4
        and source.parts[:3] == ("docs", "changes", "active")
        and target.parts[:3] == ("docs", "changes", "completed")
        and source.name == target.name
        and source.suffix == ".md"
    )


def _work_item_id_from_plan_path(path: Path) -> str | None:
    if len(path.parts) >= 5 and path.parts[:3] == ("docs", "plans", "active"):
        return path.parts[3]
    return None


def _context_string(context: RunContext, key: str) -> str | None:
    value = context.metadata.get(key)
    return value if isinstance(value, str) and value else None


def _requires_scope_diff_validation(step: Step) -> bool:
    return step.kind == StepKind.AGENT and step.agent_id == "implementation_executor"


def _requires_rollback_snapshot(step: Step) -> bool:
    return step.kind in {StepKind.AGENT, StepKind.SHELL, StepKind.GIT}


def _runtime_scope_allow_patterns(
    context: RunContext,
    step_dir: Path,
) -> tuple[ScopePattern, ...]:
    run_dir = context.run_dir
    return (
        ScopePattern(
            str(_relative_to_repo(step_dir, context)) + "/",
            "runtime step artifacts",
        ),
        ScopePattern(
            str(_relative_to_repo(run_dir, context)) + "/",
            "runtime run artifacts",
        ),
    )


def _semantic_contract_preflight(step: Step, context: RunContext) -> str | None:
    if _is_plan_review_step(step):
        return _plan_review_contract_preflight(step, context)
    if not _is_use_case_planner_step(step):
        return None
    work_item = _use_case_work_item_for_step(step, context)
    if work_item is None:
        return None
    return _contract_error(validate_use_case_e2e_alignment(context.repo_root, work_item))


def _plan_completion_contract_error(context: RunContext, plan_path: Path) -> str | None:
    work_item_id = _work_item_id_from_plan_path(plan_path)
    if not work_item_id:
        return None
    work_item = _use_case_work_item(work_item_id)
    return _contract_error(
        validate_technical_decision_plan_coverage(context.repo_root, work_item)
    )


def _contract_error(result: ContractValidationResult) -> str | None:
    if result.status != ContractValidationStatus.FAIL:
        return None
    return (
        f"{result.contract_id} failed between {result.from_path} and {result.to_path}: "
        f"{result.blocker}"
    )


def _plan_review_contract_preflight(step: Step, context: RunContext) -> str | None:
    plan_path = _active_plan_input_path(step, context)
    if plan_path is None:
        return None
    absolute = context.repo_root / plan_path
    if not absolute.is_file():
        return f"plan review contract preflight failed: missing active plan `{plan_path}`"
    text = absolute.read_text(encoding="utf-8")
    problems: list[str] = []
    application_contract = _section_text(text, ("패키지 및 의존성 계약", "Package", "Dependencies"))
    if not application_contract:
        application_contract = text
    if re.search(r"application[^\n]{0,160}ui\.dto", application_contract, flags=re.IGNORECASE):
        problems.append(
            "application layer contract must not depend on `ui.dto`; map UI DTOs at the UI boundary"
        )
    if _plan_requires_ci_runtime_coverage(text) and not _plan_declares_ci_runtime_coverage(text):
        problems.append(
            "runtime/server changes must include `.github/workflows/**` CI coverage "
            "for bounded build/test and applicable smoke verification, or explicit N/A reason"
        )
    focused = _section_text(text, ("집중 검증", "Focused Verification"))
    if focused and _has_e2e_goal_input(step) and not _contains_e2e_or_maintenance_command(focused):
        problems.append(
            "`## 집중 검증` must include an explicit E2E or maintenance verification command for the approved e2e-goal"
        )
    problems.extend(_focused_verification_contract_problems(focused))
    if not problems:
        return None
    return "plan review contract preflight failed: " + "; ".join(problems)


def _is_plan_review_step(step: Step) -> bool:
    return step.id == "review-work-item-plan" and step.agent_id == "artifact_reviewer"


def _active_plan_input_path(step: Step, context: RunContext) -> Path | None:
    for path in (*step.inputs, *step.outputs):
        if _work_item_id_from_plan_path(path):
            return path
    work_item_id = _context_string(context, "active_work_item_id")
    if work_item_id:
        candidate = Path("docs/plans/active") / work_item_id / "plan.md"
        if (context.repo_root / candidate).is_file():
            return candidate
    return None


def _has_e2e_goal_input(step: Step) -> bool:
    return any(path.name == "e2e-goal.md" for path in step.inputs)


def _contains_e2e_or_maintenance_command(text: str) -> bool:
    lowered = text.lower()
    if not any(marker in lowered for marker in ("e2e", "maintenance", "유지보수")):
        return False
    return "`" in text or "command" in lowered or "명령" in text or "./" in text


def _focused_verification_contract_problems(text: str) -> list[str]:
    if not text:
        return []
    problems: list[str] = []
    for line in text.splitlines():
        if re.search(r"VERIFY-\d+", line) is None:
            continue
        custom_root_gradle_task = _custom_root_gradle_verification_task(line)
        if custom_root_gradle_task and not _line_declares_command_scope(line):
            problems.append(
                "`## 집중 검증` custom root Gradle verification commands must be "
                "module-qualified, path-scoped, marked not applicable, or document "
                "repo capability and work-item scope"
            )
        if "run app --foreground" in line and not _line_declares_runtime_environment_blocker(line):
            problems.append(
                "`## 집중 검증` runtime verification must declare Docker/infrastructure "
                "preconditions and an environment-blocker path before using foreground app runs"
            )
    return problems


def _plan_requires_ci_runtime_coverage(text: str) -> bool:
    lowered = text.lower()
    runtime_markers = (
        "scripts/app/dev/",
        "scripts/run-app",
        "docker-compose",
        "docker compose",
        "dockerfile",
        "harness run app",
        "runtime server verification",
        "런타임",
        "새 서버",
    )
    service_markers = (
        "compose service",
        "new service",
        "new server",
        "runnable server",
        "runnable application",
        "실행 서버",
    )
    return any(marker in lowered for marker in runtime_markers + service_markers)


def _plan_declares_ci_runtime_coverage(text: str) -> bool:
    lowered = text.lower()
    has_ci_marker = (
        ".github/workflows" in lowered
        or "github actions" in lowered
        or re.search(r"\bci\b", lowered) is not None
    )
    if not has_ci_marker:
        return False
    has_coverage_or_na = any(
        marker in lowered
        for marker in (
            "build",
            "test",
            "smoke",
            "검증",
            "n/a",
            "not applicable",
            "적용 불가",
        )
    )
    return has_coverage_or_na


_STANDARD_ROOT_GRADLE_TASKS = {
    "assemble",
    "build",
    "check",
    "clean",
    "test",
}


def _custom_root_gradle_verification_task(line: str) -> str | None:
    for command in re.findall(r"`([^`]*\./gradlew[^`]*)`", line):
        task = _first_gradle_task(command)
        if task is None or task.startswith(":") or task in _STANDARD_ROOT_GRADLE_TASKS:
            continue
        return task
    return None


def _first_gradle_task(command: str) -> str | None:
    try:
        parts = shlex.split(command)
    except ValueError:
        parts = command.split()
    try:
        gradle_index = next(
            index
            for index, part in enumerate(parts)
            if part.endswith("/gradlew") or part == "./gradlew"
        )
    except StopIteration:
        return None
    index = gradle_index + 1
    while index < len(parts):
        part = parts[index]
        if part.startswith("-"):
            index += 2 if part in {"-D", "-P", "-I", "--init-script", "--project-dir"} else 1
            continue
        return part
    return None


def _line_declares_command_scope(line: str) -> bool:
    lowered = line.lower()
    return (
        _line_declares_command_not_used(line)
        or "module-scoped" in lowered
        or "module scoped" in lowered
        or "path-scoped" in lowered
        or "path scoped" in lowered
        or "work-item scope" in lowered
        or "repo capability" in lowered
        or "모듈 범위" in line
        or "경로 범위" in line
        or "작업 범위" in line
        or "저장소 기능" in line
    )


def _line_declares_runtime_environment_blocker(line: str) -> bool:
    lowered = line.lower()
    return (
        "docker" in lowered
        and (
            "environment blocker" in lowered
            or "environment-blocker" in lowered
            or "환경 blocker" in lowered
            or "환경 블로커" in lowered
        )
    )


def _line_declares_command_not_used(line: str) -> bool:
    lowered = line.lower()
    return (
        "not used" in lowered
        or "not applicable" in lowered
        or "n/a" in lowered
        or "사용하지 않는다" in line
        or "사용 안 함" in line
        or "해당 없음" in line
    )


def _section_text(text: str, title_fragments: tuple[str, ...]) -> str:
    matches = list(re.finditer(r"^(#{2,3})\s+(.+?)\s*$", text, flags=re.MULTILINE))
    for index, match in enumerate(matches):
        title = match.group(2)
        if not any(fragment.lower() in title.lower() for fragment in title_fragments):
            continue
        level = len(match.group(1))
        start = match.end()
        end = len(text)
        for next_match in matches[index + 1 :]:
            if len(next_match.group(1)) <= level:
                end = next_match.start()
                break
        return text[start:end]
    return ""


def _is_use_case_planner_step(step: Step) -> bool:
    if step.id == "planner-create-use-case-plan":
        return True
    return step.metadata.get("stage") == "planner" and step.metadata.get("scope") == "use_case"


def _is_plan_work_item_step(step: Step) -> bool:
    return step.id == "plan-work-item" or step.agent_id == "implementation_planner"


def _read_plan_output(step: Step, context: RunContext) -> str | None:
    for path in step.outputs:
        if len(path.parts) >= 5 and path.parts[:3] == ("docs", "plans", "active") and path.name == "plan.md":
            absolute = context.repo_root / path
            return absolute.read_text(encoding="utf-8") if absolute.exists() else ""
    return None


def _use_case_work_item_for_step(step: Step, context: RunContext) -> AffectedWorkItem | None:
    work_item_id = _context_string(context, "active_work_item_id")
    if not work_item_id:
        for path in (*step.outputs, *step.inputs):
            work_item_id = _work_item_id_from_plan_path(path) or _work_item_id_from_slice_path(path)
            if work_item_id:
                break
    return _use_case_work_item(work_item_id) if work_item_id else None


def _use_case_work_item(work_item_id: str) -> AffectedWorkItem:
    return AffectedWorkItem(
        work_item_id=work_item_id,
        work_item_type=WorkItemType.USE_CASE,
        name=work_item_id,
        impact_type="modify",
        slice_path=Path("docs/use-cases") / work_item_id,
    )


def _work_item_id_from_slice_path(path: Path) -> str | None:
    parts = path.parts
    if len(parts) >= 3 and parts[:2] == ("docs", "use-cases") and parts[2].startswith("UC-"):
        return parts[2]
    return None


def _first_line(value: str) -> str:
    return value.strip().splitlines()[0][:240] if value.strip() else ""


def _load_agent_config(path: Path) -> Mapping[str, Any]:
    with path.open("rb") as file:
        agent_config = tomllib.load(file)
    return _merge_agent_capabilities(path, agent_config)


def _merge_agent_capabilities(path: Path, agent_config: Mapping[str, Any]) -> Mapping[str, Any]:
    manifest_path = _agent_capability_manifest_path(path)
    if not manifest_path.exists():
        return agent_config
    with manifest_path.open("rb") as file:
        manifest = tomllib.load(file)
    defaults = _capabilities_section(manifest.get("defaults"))
    agents = manifest.get("agents")
    agent_id = path.stem
    agent_entry = agents.get(agent_id) if isinstance(agents, Mapping) else None
    selected = _capabilities_section(agent_entry)
    capabilities = {
        **defaults,
        **selected,
    }
    if not capabilities:
        return agent_config
    return {
        **dict(agent_config),
        "capabilities": capabilities,
        "capability_manifest": _display_capability_manifest_path(path, manifest_path),
    }


def _agent_capability_manifest_path(agent_config_path: Path) -> Path:
    repo_manifest = agent_config_path.parents[2] / ".harness/agents/capabilities.toml"
    if repo_manifest.exists():
        return repo_manifest
    return agent_config_path.parent / "capabilities.toml"


def _display_capability_manifest_path(agent_config_path: Path, manifest_path: Path) -> str:
    try:
        return str(manifest_path.relative_to(agent_config_path.parents[2]))
    except ValueError:
        return str(manifest_path)


def _capabilities_section(value: Any) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        return {}
    capabilities = value.get("capabilities")
    if not isinstance(capabilities, Mapping):
        return {}
    result: dict[str, Any] = {}
    for key in ("tool_groups", "mcp_servers"):
        entries = capabilities.get(key)
        if isinstance(entries, list) and all(isinstance(item, str) for item in entries):
            result[key] = sorted({item.strip() for item in entries if item.strip()})
    return result


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


def _agent_input_preflight(step: Step, context: RunContext, step_dir: Path) -> str | None:
    missing = [
        str(path)
        for path in step.inputs
        if not (context.repo_root / path).exists()
    ]
    payload = {
        "step_id": step.id,
        "agent_id": step.agent_id,
        "status": "blocked" if missing else "passed",
        "missing_inputs": missing,
    }
    preflight_path = step_dir / "input-preflight.json"
    preflight_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if not missing:
        return None
    return "agent input preflight failed: missing inputs: " + ", ".join(missing)


def _validate_agent_outputs(step: Step, context: RunContext) -> str | None:
    missing: list[str] = []
    for output in step.outputs:
        path = context.repo_root / output
        if not path.exists():
            missing.append(str(output))
    if missing:
        return "missing agent outputs: " + ", ".join(missing)

    completed_plan_outputs = tuple(
        output
        for output in step.outputs
        if output.name == "plan.md"
        and output.parts[:3] == ("docs", "plans", "completed")
    )
    if step.agent_id == "implementation_executor" and completed_plan_outputs:
        active_plan = context.active_plan_path
        if not active_plan.is_absolute():
            active_plan = context.repo_root / active_plan
        if active_plan.exists():
            return (
                "implementation plan remains active after executor success: "
                f"{_relative_to_repo(active_plan, context)}"
            )
        for output in completed_plan_outputs:
            try:
                validate_plan_completion(
                    context.repo_root,
                    output,
                    change_set_id=_context_string(context, "change_set_id"),
                    work_item_id=(
                        _context_string(context, "active_work_item_id")
                        or _context_string(context, "uc_id")
                    ),
                )
            except PlanCompletionBlocked as exc:
                _restore_invalid_completed_plan(
                    context,
                    completed_plan=output,
                    active_plan=context.active_plan_path,
                )
                return f"implementation plan completion validation failed: {exc.reason}"
            text = (context.repo_root / output).read_text(encoding="utf-8")
            change_set_id = _context_string(context, "change_set_id")
            if change_set_id:
                foreign_change_sets = sorted(
                    {
                        match
                        for match in re.findall(r"\bCHG-\d{8}-\d+\b", text)
                        if match != change_set_id
                    }
                )
                if foreign_change_sets:
                    return (
                        "completed implementation plan references other ChangeSet IDs: "
                        + ", ".join(foreign_change_sets)
                    )

    slice_outputs = step.metadata.get("slice_outputs")
    if not isinstance(slice_outputs, Mapping):
        return None
    root_value = slice_outputs.get("root")
    required_value = slice_outputs.get("required_per_use_case")
    if not isinstance(root_value, str) or not root_value.strip():
        return None
    if not isinstance(required_value, Sequence) or isinstance(required_value, (str, bytes)):
        return None

    uc_dirs = _slice_output_dirs(context.repo_root / root_value, step, context)
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


def _plan_mutation_prompt_suffix(
    *,
    request_path: Path | None,
    context: RunContext,
) -> str:
    if request_path is None:
        return ""
    return "\n".join(
        [
            "Runtime plan mutation contract:",
            f"- Read `{_relative_to_repo(request_path, context)}` before editing the active plan.",
            "- Repair the active plan into a clean current-run executor input; a focused rewrite of affected plan sections is allowed.",
            "- Remove completed checklist items that need no more work.",
            "- If a completed item needs more work, rewrite it as a current-run `- [ ]` task.",
            "- Clear stale prior-run PASS evidence from active-plan verification results.",
            "- Edit only sections allowed by the mutation request.",
            "- Do not add unresolved blocker tasks to the executor checklist.",
        ]
    )


def _planner_product_scope_prompt_suffix(step: Step) -> str:
    if not _is_plan_work_item_step(step):
        return ""
    return "\n".join(
        [
            "Runtime planner scope contract:",
            "- The plan execution boundary must describe product implementation scope, not an exhaustive exact-file allowlist.",
            "- Use module/package/path patterns for source code, tests, build files, and maintained execution scripts.",
            "- Do not force the executor to stop only because an in-module source/test/build/script file is missing from a listed file set.",
            "- Never include workflow control-plane, agent config, agent skill, runtime, review, dashboard, or harness policy paths in implementation scope.",
        ]
    )


def _implementation_completion_prompt_suffix(
    step: Step,
    context: RunContext,
) -> str:
    if step.agent_id != "implementation_executor":
        return ""
    work_item_id = (
        _context_string(context, "active_work_item_id")
        or _context_string(context, "uc_id")
        or "UNKNOWN"
    )
    evidence_root = _relative_to_repo(
        context.repo_root
        / ".harness/runs"
        / context.run_id
        / "work-items"
        / work_item_id
        / "steps"
        / step.id
        / "evidence",
        context,
    )
    return "\n".join(
        [
            "Runtime completion contract:",
            "- Do not edit the active plan during implementation.",
            "- Treat active-plan path lists as task guidance, not as exhaustive write authority.",
            "- Do not block solely because an in-scope source, test, build, or maintained script path is absent from a plan file list.",
            "- Do not create dev/prod runtime wrapper scripts, Dockerfiles, compose files, or deployment scaffolding unless the active plan explicitly names them as product deliverables.",
            "- Runtime scope validation after execution enforces the ChangeSet boundary; stay within product implementation scope and let that validator reject truly out-of-scope writes.",
            f"- Store final verification evidence files under `{evidence_root}`.",
            "- Write one canonical `subagent-result.xml` using the existing subagent-result-v1 contract.",
            "- Use one `<outcome status>` value: `succeeded`, `failed`, or `blocked`.",
            "- Set `status` to `completed` only when implementation and focused verification are complete.",
            "- The `verification` list must contain these exact labels with `status: PASS` and evidence paths:",
            f"  - Build -> `{evidence_root / 'build.txt'}`",
            f"  - Tests -> `{evidence_root / 'tests.txt'}`",
            f"  - E2E 또는 maintenance verification -> `{evidence_root / 'e2e.txt'}`",
            f"  - Runtime server verification -> `{evidence_root / 'runtime.txt'}`",
            f"  - Static analysis -> `{evidence_root / 'static-analysis.txt'}`",
            "- Every referenced evidence file must exist and contain the observed "
            "command/result summary.",
        ]
    )


def _local_reviewer_prompt_suffix(step: Step, context: RunContext) -> str:
    del context
    if not _truthy_env(LOCAL_REVIEWER_ENV):
        return ""
    if step.id != "review-work-item-plan" or step.agent_id != "artifact_reviewer":
        return ""
    return "\n".join(
        [
            "Local reviewer output contract:",
            "- You are running through a local Ollama model without filesystem tools.",
            "- Return the complete review Markdown as stdout only.",
            "- The runtime will write stdout to the declared review artifact.",
            "- Include exactly one status line: `Review Status: approved` or `Review Status: rejected`.",
            "- Prefer `rejected` when the plan is unsafe, incomplete, contradictory, or missing required verification.",
            "- Keep output concise and in Korean.",
        ]
    )


def _restore_invalid_completed_plan(
    context: RunContext,
    *,
    completed_plan: Path,
    active_plan: Path,
) -> None:
    completed = context.repo_root / completed_plan
    active = active_plan if active_plan.is_absolute() else context.repo_root / active_plan
    if not completed.exists() or active.exists():
        return
    active.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(completed), str(active))


def _slice_output_dirs(slice_root: Path, step: Step, context: RunContext) -> list[Path]:
    target_uc = _target_use_case_id(step, context)
    if target_uc:
        return [slice_root / target_uc]
    return sorted(path for path in slice_root.glob("UC-*") if path.is_dir())


def _target_use_case_id(step: Step, context: RunContext) -> str | None:
    for value in (
        step.metadata.get("target_uc"),
        step.metadata.get("uc_id"),
        context.metadata.get("target_uc"),
        context.metadata.get("uc_id"),
    ):
        if isinstance(value, str) and value.startswith("UC-"):
            return value
    return None


def _validate_review_gate(step: Step, context: RunContext) -> str | None:
    gate = step.metadata.get("review_gate")
    if not isinstance(gate, Mapping):
        return None

    output_value = gate.get("output")
    output_path = Path(output_value) if isinstance(output_value, str) and output_value else None
    if output_path is None:
        output_path = step.outputs[0] if step.outputs else None
    if output_path is None:
        return "review gate requires an output artifact"

    review_path = context.repo_root / output_path
    if not review_path.exists():
        return f"missing review gate output: {output_path}"

    status_label = gate.get("status_label")
    label = status_label if isinstance(status_label, str) and status_label else "Review Status"
    approved_value = gate.get("approved_status")
    approved = (
        approved_value if isinstance(approved_value, str) and approved_value else "approved"
    ).strip().lower()
    status = _review_status_from_text(review_path.read_text(encoding="utf-8"), label)

    if status is None:
        return f"review gate output missing `{label}: {approved}`"
    if status.strip().lower() != approved:
        return f"review gate status is `{status}`, expected `{approved}`"
    return None


def _review_status_from_text(text: str, label: str) -> str | None:
    prefix = f"{label}:"
    status: str | None = None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(prefix):
            status = stripped[len(prefix) :].strip()
    return status


def _review_input_hash(
    step: Step,
    context: RunContext,
    agent_config_path: Path,
    skill_path: Path | None,
) -> str:
    if not _review_cache_enabled(step):
        return ""
    digest = hashlib.sha256()
    digest.update(step.id.encode("utf-8"))
    digest.update((step.agent_id or "").encode("utf-8"))
    _hash_path(digest, context.repo_root, agent_config_path)
    if skill_path is not None:
        _hash_path(digest, context.repo_root, skill_path)
    for raw_path in step.inputs:
        _hash_path(digest, context.repo_root, context.repo_root / raw_path)
    return digest.hexdigest()


def _restore_cached_review(
    step: Step,
    context: RunContext,
    step_dir: Path,
    input_hash: str,
) -> StepResult | None:
    if not input_hash:
        return None
    canonical = _restore_canonical_plan_review(step, context, step_dir, input_hash)
    if canonical is not None:
        return canonical
    cache_dir = _persistent_review_root(context) / ".harness/review-cache" / str(step.agent_id) / input_hash
    metadata_path = cache_dir / "metadata.json"
    artifact_path = cache_dir / "review.md"
    if not metadata_path.is_file() or not artifact_path.is_file():
        return None
    output_path = _review_output_path(step, context)
    if output_path is None:
        return None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(artifact_path, output_path)
    result_path = step_dir / "result.json"
    metadata = {
        "review_cache_hit": True,
        "input_hash": input_hash,
        "cached_artifact": str(_relative_to_repo(artifact_path, context)),
        "restored_output": str(_relative_to_repo(output_path, context)),
        "reviewer_usage": _reviewer_usage_metadata({}, cache_hit=True),
    }
    result_path.write_text(
        json.dumps(
            {
                "step_id": step.id,
                "agent_id": step.agent_id,
                "skill_id": _step_skill_id(step),
                "status": StepStatus.SUCCEEDED.value,
                "exit_code": 0,
                "error": None,
                "metadata": metadata,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return StepResult(
        step_id=step.id,
        status=StepStatus.SUCCEEDED,
        exit_code=0,
        output_path=_relative_to_repo(result_path, context),
        metadata=metadata,
    )


def _store_cached_review(step: Step, context: RunContext, input_hash: str) -> None:
    if not input_hash:
        return
    output_path = _review_output_path(step, context)
    if output_path is None or not output_path.is_file():
        return
    _store_canonical_plan_review(step, context, output_path, input_hash)
    cache_dir = _persistent_review_root(context) / ".harness/review-cache" / str(step.agent_id) / input_hash
    cache_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(output_path, cache_dir / "review.md")
    (cache_dir / "metadata.json").write_text(
        json.dumps(
            {
                "status": "approved",
                "input_hash": input_hash,
                "source_output": str(_relative_to_repo(output_path, context)),
                "agent_id": step.agent_id,
                "step_id": step.id,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _restore_canonical_plan_review(
    step: Step,
    context: RunContext,
    step_dir: Path,
    input_hash: str,
) -> StepResult | None:
    if not _is_plan_review_step(step):
        return None
    approval_path = _canonical_plan_review_path(context)
    if approval_path is None or not approval_path.is_file():
        return None
    try:
        from harness_codex.runtime.xml_handoff import read_handoff

        approval = read_handoff(approval_path, expected_type="gate-verdict")
    except ValueError:
        return None
    if approval.get("status") != "approved" or approval.get("input_hash") != input_hash:
        return None
    output_path = _review_output_path(step, context)
    if output_path is None:
        return None
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(_canonical_plan_review_markdown(approval), encoding="utf-8")
    result_path = step_dir / "result.json"
    metadata = {
        "review_cache_hit": True,
        "review_cache_source": "canonical-plan-review",
        "input_hash": input_hash,
        "cached_artifact": str(_relative_to_repo(approval_path, context)),
        "restored_output": str(_relative_to_repo(output_path, context)),
        "reviewer_usage": _reviewer_usage_metadata({}, cache_hit=True),
    }
    result_path.write_text(
        json.dumps(
            {
                "step_id": step.id,
                "agent_id": step.agent_id,
                "skill_id": _step_skill_id(step),
                "status": StepStatus.SUCCEEDED.value,
                "exit_code": 0,
                "error": None,
                "metadata": metadata,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return StepResult(
        step_id=step.id,
        status=StepStatus.SUCCEEDED,
        exit_code=0,
        output_path=_relative_to_repo(result_path, context),
        metadata=metadata,
    )


def _store_canonical_plan_review(
    step: Step,
    context: RunContext,
    output_path: Path,
    input_hash: str,
) -> None:
    if not _is_plan_review_step(step):
        return
    approval_path = _canonical_plan_review_path(context)
    if approval_path is None:
        return
    status = _review_status_from_text(
        output_path.read_text(encoding="utf-8", errors="replace"),
        str(step.metadata.get("review_gate", {}).get("status_label", "Review Status"))
        if isinstance(step.metadata.get("review_gate"), Mapping)
        else "Review Status",
    )
    if (status or "").casefold() != "approved":
        return
    plan_path = _active_plan_input_path(step, context)
    payload = {
        "schema_version": 1,
        "gate_id": "plan-review",
        "status": "approved",
        "source_path": str(_relative_to_repo(output_path, context)),
        "input_hash": input_hash,
        "plan_path": str(plan_path or ""),
        "plan_sha256": _sha256_file(context.repo_root / plan_path) if plan_path else "",
        "work_item_id": _context_string(context, "active_work_item_id")
        or _context_string(context, "uc_id")
        or "",
    }
    from harness_codex.runtime.xml_handoff import write_handoff

    write_handoff(approval_path, "gate-verdict", payload)


def _canonical_plan_review_path(context: RunContext) -> Path | None:
    work_item_id = _context_string(context, "active_work_item_id") or _context_string(context, "uc_id")
    if not work_item_id:
        return None
    return _persistent_review_root(context) / "docs/plans/active" / work_item_id / "plan-review.xml"


def _persistent_review_root(context: RunContext) -> Path:
    resolved_run_dir = context.run_dir.resolve()
    parts = resolved_run_dir.parts
    for index in range(len(parts) - 1):
        if parts[index] == ".harness" and parts[index + 1] == "runs":
            return Path(*parts[:index])
    return context.repo_root


def _canonical_plan_review_markdown(approval: Mapping[str, Any]) -> str:
    return "\n".join(
        [
            "# Plan Review",
            "",
            "Review Status: approved",
            "",
            "## Canonical Approval",
            f"- Source: `{approval.get('source_path', '')}`",
            f"- Input hash: `{approval.get('input_hash', '')}`",
            f"- Plan: `{approval.get('plan_path', '')}`",
            f"- Plan SHA-256: `{approval.get('plan_sha256', '')}`",
            "",
        ]
    )


def _review_output_path(step: Step, context: RunContext) -> Path | None:
    gate = step.metadata.get("review_gate")
    output = gate.get("output") if isinstance(gate, Mapping) else ""
    if isinstance(output, str) and output:
        return context.repo_root / _replace_runtime_placeholders(output, context)
    if step.outputs:
        return context.repo_root / step.outputs[0]
    return None


def _replace_runtime_placeholders(value: str, context: RunContext) -> Path:
    replacements = {
        "<RUN-ID>": context.run_id,
        "<WORK-ITEM-ID>": str(context.metadata.get("active_work_item_id") or ""),
        "<UC-ID>": str(
            context.metadata.get("uc_id")
            or context.metadata.get("target_uc")
            or context.metadata.get("active_work_item_id")
            or ""
        ),
        "<MAINT-ID>": str(context.metadata.get("active_work_item_id") or ""),
        "<CHG-ID>": str(context.metadata.get("change_set_id") or ""),
    }
    replaced = value
    for placeholder, actual in replacements.items():
        replaced = replaced.replace(placeholder, actual)
    return Path(replaced)


def _review_cache_enabled(step: Step) -> bool:
    return step.agent_id in {"artifact_reviewer", "security_plan_reviewer"}


def _reviewer_usage_metadata(
    metadata: Mapping[str, Any],
    *,
    cache_hit: bool,
) -> dict[str, int]:
    usage = metadata.get("usage") if isinstance(metadata, Mapping) else None
    usage_map = usage if isinstance(usage, Mapping) else {}
    return {
        "input_tokens": int(usage_map.get("input_tokens") or 0),
        "cached_input_tokens": int(usage_map.get("cached_input_tokens") or 0),
        "output_tokens": int(usage_map.get("output_tokens") or 0),
        "reasoning_tokens": int(usage_map.get("reasoning_tokens") or 0),
        "provider_calls": 0 if cache_hit else 1,
    }


def _hash_path(digest, repo_root: Path, path: Path) -> None:
    if not path.exists():
        digest.update(f"missing:{_safe_relative(path, repo_root)}\n".encode("utf-8"))
        return
    if path.is_dir():
        for child in sorted(item for item in path.rglob("*") if item.is_file()):
            _hash_path(digest, repo_root, child)
        return
    digest.update(f"path:{_safe_relative(path, repo_root)}\n".encode("utf-8"))
    digest.update(path.read_bytes())
    digest.update(b"\n")


def _sha256_file(path: Path) -> str:
    if not path.is_file():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _safe_relative(path: Path, repo_root: Path) -> str:
    try:
        return str(path.relative_to(repo_root))
    except ValueError:
        return str(path)


def _update_generated_output_contracts(step: Step, context: RunContext) -> None:
    change_set_id = _context_string(context, "change_set_id") or ""
    work_item_id = _context_string(context, "active_work_item_id") or ""
    source_docs = tuple(step.inputs)
    for output in step.outputs:
        ensure_generated_document_metadata(
            context.repo_root,
            output,
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            source_docs=source_docs,
            status=_metadata_status_for_output(output),
        )


def _metadata_status_for_output(output: Path) -> str:
    if output.name == "plan.md":
        if output.parts[:3] == ("docs", "plans", "completed"):
            return "completed"
        return "active"
    if output.name in {"event-storming.md", "ddd-design.md", "technical-decisions.md"}:
        return "ready"
    return ""


def _run_agent_provider_process(
    *,
    request: AgentRunRequest,
    command: list[str],
    prompt: str,
    stdout_path: Path,
    stderr_path: Path,
    provider_metadata: dict[str, Any],
) -> _ProviderCompleted:
    tmux_session = _agent_tmux_session_name(request)
    if _agent_tmux_enabled(request) and shutil.which("tmux") is not None:
        tmux_mode = "pane" if os.environ.get("TMUX") else "session"
        tmux_result = _run_agent_provider_process_in_tmux(
            request=request,
            command=command,
            prompt=prompt,
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            session_name=tmux_session,
        )
        provider_metadata.update(
            {
                "tmux_session": tmux_session,
                "tmux_mode": tmux_mode,
                "tmux_attach_command": _agent_tmux_attach_command(tmux_session),
                "tmux_kill_command": (
                    "close the attached tmux pane"
                    if tmux_mode == "pane"
                    else f"tmux kill-session -t {tmux_session}"
                ),
                **dict(tmux_result.metadata),
            }
        )
        return tmux_result

    with (
        stdout_path.open("w", encoding="utf-8") as stdout_stream,
        stderr_path.open("w", encoding="utf-8") as stderr_stream,
    ):
        completed = subprocess.run(
            command,
            cwd=request.context.workdir,
            input=prompt,
            text=True,
            stdout=stdout_stream,
            stderr=stderr_stream,
            timeout=request.step.timeout_sec,
            check=False,
        )
    return _ProviderCompleted(returncode=completed.returncode)


def _run_agent_provider_process_in_tmux(
    *,
    request: AgentRunRequest,
    command: list[str],
    prompt: str,
    stdout_path: Path,
    stderr_path: Path,
    session_name: str,
) -> _ProviderCompleted:
    prompt_path = request.step_dir / "tmux-stdin.txt"
    exit_code_path = request.step_dir / "tmux-exit-code.txt"
    script_path = request.step_dir / "tmux-run.sh"
    prompt_path.write_text(prompt, encoding="utf-8")
    exit_code_path.unlink(missing_ok=True)

    script = "\n".join(
        [
            "#!/usr/bin/env bash",
            "set +e",
            f"cd {shlex.quote(str(request.context.workdir))}",
            (
                f"{shlex.join(command)} "
                f"< {shlex.quote(str(prompt_path))} "
                f"> {shlex.quote(str(stdout_path))} "
                f"2> {shlex.quote(str(stderr_path))}"
            ),
            "exit_code=$?",
            f"printf '%s\\n' \"$exit_code\" > {shlex.quote(str(exit_code_path))}",
            "exit \"$exit_code\"",
            "",
        ]
    )
    script_path.write_text(script, encoding="utf-8")
    script_path.chmod(0o700)

    if os.environ.get("TMUX"):
        return _run_agent_provider_process_in_tmux_pane(
            request=request,
            script_path=script_path,
            exit_code_path=exit_code_path,
            command=command,
        )

    subprocess.run(
        ["tmux", "kill-session", "-t", session_name],
        cwd=request.context.workdir,
        text=True,
        capture_output=True,
        check=False,
    )
    subprocess.run(
        [
            "tmux",
            "new-session",
            "-d",
            "-s",
            session_name,
            "-n",
            request.step.id[:32],
            "bash",
            str(script_path),
        ],
        cwd=request.context.workdir,
        text=True,
        capture_output=True,
        timeout=10,
        check=True,
    )
    subprocess.run(
        ["tmux", "set-option", "-t", session_name, "remain-on-exit", "on"],
        cwd=request.context.workdir,
        text=True,
        capture_output=True,
        check=False,
    )

    deadline = (
        time.monotonic() + request.step.timeout_sec
        if request.step.timeout_sec is not None
        else None
    )
    while not exit_code_path.exists():
        if deadline is not None and time.monotonic() >= deadline:
            subprocess.run(
                ["tmux", "kill-session", "-t", session_name],
                cwd=request.context.workdir,
                text=True,
                capture_output=True,
                check=False,
            )
            raise subprocess.TimeoutExpired(command, request.step.timeout_sec)
        time.sleep(0.25)

    try:
        return_code = int(exit_code_path.read_text(encoding="utf-8").strip())
    except ValueError:
        return_code = 1
    return _ProviderCompleted(returncode=return_code, metadata={"tmux_mode": "session"})


def _run_agent_provider_process_in_tmux_pane(
    *,
    request: AgentRunRequest,
    script_path: Path,
    exit_code_path: Path,
    command: list[str],
) -> _ProviderCompleted:
    pane = subprocess.run(
        [
            "tmux",
            "split-window",
            "-P",
            "-F",
            "#{pane_id}",
            "-c",
            str(request.context.workdir),
            "bash",
            str(script_path),
        ],
        cwd=request.context.workdir,
        text=True,
        capture_output=True,
        timeout=10,
        check=True,
    )
    pane_id = pane.stdout.strip()
    if pane_id:
        subprocess.run(
            ["tmux", "select-pane", "-t", pane_id, "-T", request.step.id[:32]],
            cwd=request.context.workdir,
            text=True,
            capture_output=True,
            check=False,
        )

    deadline = (
        time.monotonic() + request.step.timeout_sec
        if request.step.timeout_sec is not None
        else None
    )
    while not exit_code_path.exists():
        if deadline is not None and time.monotonic() >= deadline:
            if pane_id:
                subprocess.run(
                    ["tmux", "kill-pane", "-t", pane_id],
                    cwd=request.context.workdir,
                    text=True,
                    capture_output=True,
                    check=False,
                )
            raise subprocess.TimeoutExpired(command, request.step.timeout_sec)
        time.sleep(0.25)

    try:
        return_code = int(exit_code_path.read_text(encoding="utf-8").strip())
    except ValueError:
        return_code = 1
    return _ProviderCompleted(
        returncode=return_code,
        metadata={"tmux_mode": "pane", "tmux_pane": pane_id},
    )


def _agent_tmux_enabled(request: AgentRunRequest) -> bool:
    configured = request.agent_config.get("tmux")
    if isinstance(configured, bool):
        return configured
    value = os.environ.get(AGENT_TMUX_ENV, "")
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _agent_tmux_session_name(request: AgentRunRequest) -> str:
    raw = f"harness-{request.context.run_id}-{request.step.id}"
    normalized = re.sub(r"[^A-Za-z0-9_.-]+", "-", raw).strip("-")
    return normalized[:80] or "harness-agent"


def _agent_tmux_attach_command(session_name: str) -> str:
    if os.environ.get("TMUX"):
        return "already attached in a new tmux pane"
    return f"tmux attach-session -t {session_name}"


def _resolve_provider_command(
    request: AgentRunRequest,
    final_message_path: Path,
    *,
    default_codex_binary: str,
) -> tuple[list[str], dict[str, Any]] | AgentRunResult:
    config = request.agent_config
    if _local_reviewer_enabled(request):
        binary = os.environ.get(LOCAL_REVIEWER_BINARY_ENV, "ollama").strip() or "ollama"
        model = (
            os.environ.get(LOCAL_REVIEWER_MODEL_ENV)
            or DEFAULT_LOCAL_REVIEWER_MODEL
        ).strip()
        if not model:
            return _blocked_provider_result(request, "local reviewer model must be non-empty", provider="ollama")
        command = [binary, "run", model]
        return command, {
            "provider": "ollama",
            "provider_command": command,
            "local_reviewer": True,
            "local_reviewer_model": model,
            "local_reviewer_env": LOCAL_REVIEWER_ENV,
        }
    provider = config.get("provider", "codex")
    if not isinstance(provider, str) or not provider.strip():
        return _blocked_provider_result(request, "agent provider must be a non-empty string")
    provider = provider.strip()
    if provider == "codex":
        binary = config.get("provider_binary", default_codex_binary)
        if not isinstance(binary, str) or not binary.strip():
            return _blocked_provider_result(request, "codex provider_binary must be a non-empty string", provider=provider)
        override = _model_override(request)
        if override:
            config = {**config, **override["config"]}
            request = replace(request, agent_config=config)
        command = _codex_command(
            request,
            final_message_path,
            binary.strip(),
            session_id=request.resume_session_id,
        )
        metadata = {
            "provider": provider,
            "provider_command": command,
            "model": config.get("model"),
            "model_reasoning_effort": config.get("model_reasoning_effort"),
        }
        if override:
            metadata["model_override"] = override["metadata"]
        return command, metadata
    if provider == "custom_cli":
        command = _custom_provider_command(config.get("provider_command"))
        if command is None:
            return _blocked_provider_result(request, "custom_cli provider requires provider_command as a non-empty list of strings", provider=provider)
        return command, {"provider": provider, "provider_command": command}
    return _blocked_provider_result(request, f"unsupported agent provider: {provider}", provider=provider)


def _local_reviewer_enabled(request: AgentRunRequest) -> bool:
    if not _truthy_env(LOCAL_REVIEWER_ENV):
        return False
    return request.step.id == "review-work-item-plan" and request.step.agent_id == "artifact_reviewer"


def _model_override(request: AgentRunRequest) -> dict[str, Any] | None:
    if request.step.agent_id != "implementation_executor":
        return None
    difficulty = _implementation_difficulty(request)
    if difficulty in {"wide_refactor", "runtime_cleanup"}:
        return _model_override_payload("gpt-5.5", None, difficulty)
    attempt = _implementation_attempt(request)
    if attempt.get("execution_mode") == "resumed":
        attempt_number = int(attempt.get("attempt", 2) or 2)
        model = "gpt-5.5" if attempt_number >= 3 else "gpt-5.4"
        return _model_override_payload(model, None, "failed_verification_repair")
    return _model_override_payload("gpt-5.4", None, "normal_implementation")


def _model_override_payload(model: str, effort: str | None, reason: str) -> dict[str, Any]:
    config: dict[str, Any] = {"model": model}
    if effort:
        config["model_reasoning_effort"] = effort
    else:
        config["model_reasoning_effort"] = ""
    return {"config": config, "metadata": {"model": model, "model_reasoning_effort": effort, "reason": reason}}


def _implementation_difficulty(request: AgentRunRequest) -> str:
    text = _implementation_plan_text(request)
    lowered = text.casefold()
    if any(token in lowered for token in ("wide refactor", "large refactor", "대규모 리팩터", "광범위 리팩터")):
        return "wide_refactor"
    if any(token in lowered for token in ("runtime cleanup", "runtime 정리", "런타임 정리", "harness_codex/runtime")):
        return "runtime_cleanup"
    return "normal_implementation"


def _implementation_plan_text(request: AgentRunRequest) -> str:
    for raw_path in request.step.inputs:
        if raw_path.name != "plan.md":
            continue
        path = raw_path if raw_path.is_absolute() else request.context.repo_root / raw_path
        if path.is_file():
            return path.read_text(encoding="utf-8", errors="replace")
    return ""


def _truthy_env(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _stdout_backed_provider(provider: str) -> bool:
    return provider in {"custom_cli", "ollama"}


def _provider_prompt(prompt: str, provider_metadata: Mapping[str, Any]) -> str:
    if provider_metadata.get("provider") == "ollama":
        return "/no_think\n" + prompt
    return prompt


def _write_stdout_backed_outputs(request: AgentRunRequest, stdout: str, *, provider: str) -> None:
    if provider != "ollama" or not _is_plan_review_step(request.step):
        return
    output_path = _review_output_path(request.step, request.context)
    if output_path is None:
        return
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(_local_review_markdown(stdout), encoding="utf-8")


def _local_review_markdown(stdout: str) -> str:
    lines = stdout.splitlines()
    status_indexes = [
        index
        for index, line in enumerate(lines)
        if line.strip().casefold().startswith("review status:")
    ]
    if not status_indexes:
        return stdout
    selected = "\n".join(lines[status_indexes[-1] :]).strip()
    return selected + "\n"


def _codex_command(
    request: AgentRunRequest,
    final_message_path: Path,
    codex_binary: str,
    *,
    session_id: str | None = None,
) -> list[str]:
    config = request.agent_config
    command = [codex_binary, "exec"]
    if config.get("mcp_policy") == "disabled":
        command.append("--ignore-user-config")
    if session_id:
        command.extend(["resume", session_id])
    command.extend(
        [
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
        "--json",
        "--output-last-message",
        str(final_message_path.resolve()),
        ]
    )
    if not session_id:
        command.extend(["--cd", str(request.context.workdir.resolve())])
    model = config.get("model")
    if isinstance(model, str) and model:
        command.extend(["--model", model])
    reasoning_effort = config.get("model_reasoning_effort")
    if isinstance(reasoning_effort, str) and reasoning_effort:
        command.extend(["-c", f'model_reasoning_effort="{reasoning_effort}"'])
    sandbox_mode = config.get("sandbox_mode")
    if isinstance(sandbox_mode, str) and sandbox_mode:
        if session_id:
            command.extend(["-c", f'sandbox_mode="{sandbox_mode}"'])
        else:
            command.extend(["--sandbox", sandbox_mode])
    command.append("-")
    return command


def _implementation_attempt(request: AgentRunRequest) -> dict[str, Any]:
    if request.step.agent_id != "implementation_executor":
        return {"execution_mode": "fresh", "attempt": 1}
    compatibility = _implementation_compatibility(request)
    candidates: list[tuple[int, dict[str, Any], Path]] = []
    runs_root = request.context.repo_root / ".harness/runs"
    if runs_root.exists():
        for path in runs_root.glob(f"**/steps/{request.step.id}/attempt.json"):
            if path == request.step_dir / "attempt.json":
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError):
                continue
            if (
                payload.get("schema_version") == IMPLEMENTATION_ATTEMPT_SCHEMA_VERSION
                and payload.get("compatibility") == compatibility
                and isinstance(payload.get("provider_session_id"), str)
                and payload["provider_session_id"]
            ):
                candidates.append((int(payload.get("attempt", 0)), payload, path))
    if not candidates:
        return {
            "execution_mode": "fresh",
            "attempt": 1,
            "compatibility": compatibility,
        }
    previous_attempt, previous, path = max(candidates, key=lambda item: item[0])
    checkpoint_path = path.with_name("checkpoint.json")
    checkpoint: dict[str, Any] | None = None
    try:
        loaded = json.loads(checkpoint_path.read_text(encoding="utf-8"))
        if loaded.get("schema_version") == IMPLEMENTATION_CHECKPOINT_SCHEMA_VERSION:
            checkpoint = loaded
    except (OSError, ValueError, TypeError):
        pass
    return {
        "execution_mode": "resumed",
        "attempt": previous_attempt + 1,
        "compatibility": compatibility,
        "provider_session_id": previous["provider_session_id"],
        "previous_attempt_path": str(path),
        "previous_checkpoint_path": str(checkpoint_path),
        "previous_checkpoint": checkpoint,
    }


def _compact_checkpoint_for_prompt(
    checkpoint: Mapping[str, Any],
    *,
    checkpoint_path: object,
) -> dict[str, Any]:
    commands = checkpoint.get("commands")
    command_items = commands if isinstance(commands, list) else []
    compact_commands: list[dict[str, Any]] = []
    for item in command_items[-5:]:
        if not isinstance(item, Mapping):
            continue
        compact_commands.append(
            {
                "command": str(item.get("command") or "")[:240],
                "exit_code": item.get("exit_code"),
                "status": item.get("status"),
                "summary": str(item.get("summary") or item.get("error") or "")[:240],
            }
        )
    completed_tasks = checkpoint.get("completed_tasks")
    task_items = completed_tasks if isinstance(completed_tasks, list) else []
    evidence_paths = checkpoint.get("evidence_paths")
    evidence_items = evidence_paths if isinstance(evidence_paths, list) else []
    return {
        "schema_version": checkpoint.get("schema_version"),
        "source_checkpoint_path": checkpoint_path,
        "phase": checkpoint.get("phase"),
        "status": checkpoint.get("status"),
        "completed_tasks_count": len(task_items),
        "completed_tasks_tail": task_items[-10:],
        "commands_count": len(command_items),
        "commands_tail": compact_commands,
        "phase_metrics": checkpoint.get("phase_metrics"),
        "evidence_paths": evidence_items[:20],
        "next_phase": checkpoint.get("next_phase"),
        "instruction": "원본 checkpoint가 더 필요할 때만 source_checkpoint_path를 열어라.",
    }


def _implementation_compatibility(request: AgentRunRequest) -> dict[str, str]:
    scope = {
        "repo_root": str(request.context.repo_root.resolve()),
        "repository_head": _repository_head(request.context.repo_root),
        "change_set_id": _context_string(request.context, "change_set_id") or "",
        "work_item_id": _context_string(request.context, "active_work_item_id") or "",
        "agent_id": request.step.agent_id or "",
    }
    contract = json.dumps(
        {
            "scope": scope,
            "agent_config": dict(request.agent_config),
            "inputs": {
                str(path): _path_content_hash(request.context.repo_root / path)
                for path in request.step.inputs
            },
            "outputs": [str(path) for path in request.step.outputs],
            "agent_config_hash": _path_content_hash(request.agent_config_path),
            "skill_hash": (
                _path_content_hash(request.skill_path)
                if request.skill_path is not None
                else ""
            ),
        },
        ensure_ascii=False,
        sort_keys=True,
        default=str,
    )
    return {
        **scope,
        "prompt_contract_hash": hashlib.sha256(contract.encode("utf-8")).hexdigest(),
    }


def _path_content_hash(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        if path.is_file():
            digest.update(path.read_bytes())
        elif path.is_dir():
            for child in sorted(item for item in path.rglob("*") if item.is_file()):
                digest.update(str(child.relative_to(path)).encode("utf-8"))
                digest.update(child.read_bytes())
        else:
            digest.update(b"<missing>")
    except OSError:
        digest.update(b"<unreadable>")
    return digest.hexdigest()


def _repository_head(repo_root: Path) -> str:
    try:
        dot_git = repo_root / ".git"
        git_dir = dot_git
        if dot_git.is_file():
            marker = dot_git.read_text(encoding="utf-8").strip()
            if not marker.startswith("gitdir:"):
                return ""
            git_dir = (repo_root / marker.split(":", 1)[1].strip()).resolve()
        head = (git_dir / "HEAD").read_text(encoding="utf-8").strip()
        if not head.startswith("ref:"):
            return head
        reference = head.split(":", 1)[1].strip()
        direct = git_dir / reference
        if direct.exists():
            return direct.read_text(encoding="utf-8").strip()
        common_dir_path = git_dir / "commondir"
        if common_dir_path.exists():
            common_dir = (
                git_dir / common_dir_path.read_text(encoding="utf-8").strip()
            ).resolve()
            shared = common_dir / reference
            if shared.exists():
                return shared.read_text(encoding="utf-8").strip()
        return head
    except OSError:
        return ""


def _codex_session_id(stdout: str) -> str | None:
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        for key in ("session_id", "thread_id", "conversation_id"):
            value = event.get(key)
            if isinstance(value, str) and value:
                return value
        payload = event.get("payload")
        if isinstance(payload, Mapping):
            for key in ("session_id", "thread_id", "conversation_id", "id"):
                value = payload.get(key)
                if isinstance(value, str) and value and "started" in str(event.get("type", "")):
                    return value
    return None


def _write_implementation_attempt_and_checkpoint(
    request: AgentRunRequest,
    *,
    attempt: Mapping[str, Any],
    provider_metadata: Mapping[str, Any],
    stdout: str,
    termination_reason: str,
    status: str,
) -> dict[str, Any] | None:
    if request.step.agent_id != "implementation_executor":
        return None
    session_id = provider_metadata.get("provider_session_id") or _codex_session_id(stdout)
    attempt_payload = {
        "schema_version": IMPLEMENTATION_ATTEMPT_SCHEMA_VERSION,
        "attempt": attempt.get("attempt", 1),
        "execution_mode": attempt.get("execution_mode", "fresh"),
        "provider_session_id": session_id,
        "termination_reason": termination_reason,
        "compatibility": attempt.get("compatibility", _implementation_compatibility(request)),
        "input_fingerprint": provider_metadata.get("input_fingerprint"),
        "prompt_metrics": provider_metadata.get("prompt_metrics", {}),
    }
    commands = _codex_command_records(stdout)
    completed_phases = _completed_implementation_phases(commands)
    next_phase = _next_implementation_phase(completed_phases)
    checkpoint_payload = {
        "schema_version": IMPLEMENTATION_CHECKPOINT_SCHEMA_VERSION,
        "phase": "closure" if status == "succeeded" else "implementation",
        "status": status,
        "completed_tasks": completed_phases,
        "commands": commands,
        "phase_metrics": _implementation_phase_metrics(commands, provider_metadata),
        "evidence_paths": [
            str(_relative_to_repo(request.step_dir / "stdout.txt", request.context)),
            str(_relative_to_repo(request.step_dir / "final-message.md", request.context)),
        ],
        "next_phase": None if status == "succeeded" else next_phase,
        "compatibility": attempt_payload["compatibility"],
    }
    _atomic_write_json(request.step_dir / "attempt.json", attempt_payload)
    _atomic_write_json(request.step_dir / "checkpoint.json", checkpoint_payload)
    return checkpoint_payload


def _with_implementation_checkpoint_metadata(
    result: AgentRunResult,
    checkpoint: Mapping[str, Any] | None,
) -> AgentRunResult:
    if checkpoint is None:
        return result
    return AgentRunResult(
        status=result.status,
        exit_code=result.exit_code,
        error=result.error,
        metadata={
            **dict(result.metadata),
            "phase_metrics": checkpoint.get("phase_metrics", {}),
            "next_phase": checkpoint.get("next_phase"),
        },
    )


def _implementation_phase_metrics(
    commands: Sequence[Mapping[str, Any]],
    provider_metadata: Mapping[str, Any],
) -> dict[str, dict[str, int]]:
    metrics: dict[str, dict[str, int]] = {
        phase: {
            "command_count": 0,
            "input_tokens": 0,
            "cached_input_tokens": 0,
            "output_tokens": 0,
            "reasoning_tokens": 0,
        }
        for phase in ("implementation", "focused-tests", "build", "runtime-e2e", "closure")
    }
    for command in commands:
        phase = _implementation_phase_for_command(str(command.get("command", "")))
        metrics[phase]["command_count"] += 1
    usage = provider_metadata.get("usage")
    usage_map = usage if isinstance(usage, Mapping) else {}
    phase = _next_implementation_phase(_completed_implementation_phases(commands))
    metrics[phase]["input_tokens"] = int(usage_map.get("input_tokens") or 0)
    metrics[phase]["cached_input_tokens"] = int(usage_map.get("cached_input_tokens") or 0)
    metrics[phase]["output_tokens"] = int(usage_map.get("output_tokens") or 0)
    metrics[phase]["reasoning_tokens"] = int(usage_map.get("reasoning_tokens") or 0)
    return metrics


def _implementation_phase_for_command(command: str) -> str:
    text = command.casefold()
    if any(term in text for term in ("playwright", "e2e", "run app", "bootrun")):
        return "runtime-e2e"
    if any(term in text for term in ("build", "assemble", "compile")):
        return "build"
    if any(term in text for term in ("pytest", "test", "gradlew")):
        return "focused-tests"
    return "implementation"


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def _codex_command_records(stdout: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            continue
        stack: list[Any] = [event]
        while stack:
            value = stack.pop()
            if isinstance(value, Mapping):
                command = value.get("command")
                if isinstance(command, str) and command:
                    exit_code = value.get("exit_code")
                    records.append(
                        {
                            "command": command,
                            "exit_code": exit_code if isinstance(exit_code, int) else None,
                            "status": value.get("status"),
                        }
                    )
                stack.extend(value.values())
            elif isinstance(value, list):
                stack.extend(value)
    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, Any]] = set()
    for record in records:
        key = (record["command"], record["exit_code"])
        if key not in seen:
            seen.add(key)
            deduped.append(record)
    return deduped


def _completed_implementation_phases(
    commands: Sequence[Mapping[str, Any]],
) -> list[str]:
    completed: list[str] = []
    for command in commands:
        if command.get("exit_code") != 0:
            continue
        phase = _implementation_phase_for_command(str(command.get("command", "")))
        if phase != "implementation" and "implementation" not in completed:
            completed.append("implementation")
        if phase not in completed:
            completed.append(phase)
    return completed


def _next_implementation_phase(completed: Sequence[str]) -> str:
    phases = ("implementation", "focused-tests", "build", "runtime-e2e", "closure")
    for phase in phases:
        if phase not in completed:
            return phase
    return "closure"


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


def _read_text_if_exists(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


def _successful_stderr_artifact(stderr: str) -> str:
    if len(stderr.encode("utf-8")) <= SUCCESS_STDERR_TAIL_BYTES:
        return stderr

    encoded = stderr.encode("utf-8")
    tail = encoded[-SUCCESS_STDERR_TAIL_BYTES:].decode("utf-8", errors="replace")
    return "\n".join(
        [
            "[harness-codex] successful agent stderr truncated",
            f"original_bytes={len(encoded)}",
            f"retained_tail_bytes={SUCCESS_STDERR_TAIL_BYTES}",
            "",
            tail,
        ]
    )


def _agent_process_blocker_error(output: str) -> str | None:
    for line in output.splitlines():
        normalized = line.lower()
        if "you've hit your usage limit" in normalized or "usage limit" in normalized:
            return line
        if "rate limit" in normalized:
            return line
    return None


def _blocked_agent_result(step: Step, context: RunContext, step_dir: Path, error: str) -> StepResult:
    failure_kind = (
        FailureKind.PLAN_REVIEW_REJECTED
        if step.id == "review-work-item-plan"
        and error.startswith("plan review contract preflight failed:")
        else FailureKind.ENVIRONMENT_BLOCKER
    )
    metadata = {"agent_id": step.agent_id, "skill_id": _step_skill_id(step)}
    if failure_kind == FailureKind.PLAN_REVIEW_REJECTED:
        metadata["review_gate_error"] = error
    result_path = step_dir / "result.json"
    result_path.write_text(
        json.dumps(
            {
                "step_id": step.id,
                "agent_id": step.agent_id,
                "skill_id": _step_skill_id(step),
                "status": StepStatus.BLOCKED.value,
                "error": error,
                "failure_kind": failure_kind.value,
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
        status=StepStatus.BLOCKED,
        output_path=_relative_to_repo(result_path, context),
        error=error,
        failure_kind=failure_kind,
        metadata=metadata,
    )


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


def _agent_failure_kind(
    status: StepStatus,
    metadata: Mapping[str, Any] | None = None,
    error: str | None = None,
) -> FailureKind | None:
    if status == StepStatus.FAILED:
        normalized_error = (error or "").lower()
        if (
            "401 unauthorized" in normalized_error
            or "usage limit" in normalized_error
            or "rate limit" in normalized_error
            or "failed to connect to websocket" in normalized_error
        ):
            return FailureKind.ENVIRONMENT_BLOCKER
        return FailureKind.IMPLEMENTATION
    if status == StepStatus.BLOCKED:
        if metadata and metadata.get("review_gate_error"):
            return FailureKind.PLAN_REVIEW_REJECTED
        if metadata and metadata.get("scope_diff_blocked_files"):
            return FailureKind.SCOPE_CONFLICT
        return FailureKind.ENVIRONMENT_BLOCKER
    return None
