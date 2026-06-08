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
from harness_codex.runtime.document_metadata import ensure_generated_document_metadata
from harness_codex.runtime.prompt import build_agent_prompt
from harness_codex.runtime.validate_scope_diff import (
    ScopePattern,
    capture_git_snapshot,
    validate_scope_diff,
    write_snapshot,
)


SUCCESS_STDERR_TAIL_BYTES = 16_384


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
        if provider_metadata["provider"] == "custom_cli":
            final_message_path.write_text(completed.stdout, encoding="utf-8")

        if completed.returncode != 0:
            stderr_path.write_text(completed.stderr, encoding="utf-8")
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

        stderr_path.write_text(_successful_stderr_artifact(completed.stderr), encoding="utf-8")
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
        if step.kind == StepKind.DECISION:
            return self._run_decision(step, context, step_dir)

        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            error=f"unsupported step kind: {step.kind.value}",
        )

    def _run_decision(self, step: Step, context: RunContext, step_dir: Path) -> StepResult:
        classifier = str(step.metadata.get("classifier") or "")
        if not classifier and step.id in {
            "classify-verification-result",
            "classify-use-case-verification-result",
        }:
            classifier = "verification_result"

        if classifier != "verification_result":
            evidence = _write_decision_evidence(
                step,
                context,
                step_dir,
                {
                    "classifier": classifier,
                    "decision": "UNSUPPORTED_DECISION_STEP",
                    "blocked": True,
                    "reason": "decision classifier is required",
                },
            )
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                output_path=_relative_to_repo(evidence, context),
                error="decision classifier is required",
                metadata={"decision": _decision_result_from_file(evidence)},
            )

        decision = _classify_verification_result(step, context)
        evidence = _write_decision_evidence(step, context, step_dir, decision)
        status = StepStatus.BLOCKED if decision["blocked"] else StepStatus.SUCCEEDED
        failure_kind = _decision_failure_kind(str(decision["decision"]))
        error = str(decision["reason"]) if decision["blocked"] else None
        return StepResult(
            step_id=step.id,
            status=status,
            output_path=_relative_to_repo(evidence, context),
            error=error,
            failure_kind=failure_kind if decision["blocked"] else None,
            metadata={"decision": decision},
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
                context_metadata=context.metadata,
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
        if step.metadata.get("loop_target"):
            return _append_runtime_remediation_task(step, context, step_dir)

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

    return StepResult(
        step_id=step.id,
        status=StepStatus.SUCCEEDED,
        output_path=completion.report_path,
        metadata={
            "completed_path": str(completion.completed_path),
            "completed_work_items": list(completion.completed_work_items),
            "already_completed": completion.already_completed,
        },
    )


def _classify_verification_result(
    step: Step,
    context: RunContext,
) -> dict[str, Any]:
    failed_step_id = _context_string(context, "runtime_failed_step_id")
    raw_failure_kind = _context_string(context, "runtime_failure_kind")
    raw_error = _context_string(context, "runtime_failure_error") or ""

    if not failed_step_id and not raw_failure_kind and not raw_error:
        route = _metadata_string(step, "on_success") or "complete"
        return {
            "classifier": "verification_result",
            "decision": "VERIFICATION_PASSED",
            "failed_step_id": None,
            "source_failure_kind": None,
            "route": route,
            "blocked": False,
            "owner_stage": "completion",
            "reason": "verification passed",
        }

    decision = _decision_code(raw_failure_kind or "", raw_error)
    route = _decision_route(step, decision)
    blocked = decision != "IMPLEMENTATION_FAILURE"
    return {
        "classifier": "verification_result",
        "decision": decision,
        "failed_step_id": failed_step_id,
        "source_failure_kind": raw_failure_kind,
        "route": route,
        "blocked": blocked,
        "owner_stage": _decision_owner_stage(decision),
        "reason": _decision_reason(decision, raw_error),
    }


def _decision_code(raw_failure_kind: str, raw_error: str) -> str:
    normalized = raw_failure_kind.strip().lower().replace("-", "_").replace(" ", "_")
    direct = {
        "implementation": "IMPLEMENTATION_FAILURE",
        "implementation_failure": "IMPLEMENTATION_FAILURE",
        "unclear_e2e_goal": "UNCLEAR_E2E_GOAL",
        "document_delta_conflict": "DOCUMENT_DELTA_CONFLICT",
        "upstream_design": "UPSTREAM_DESIGN_CONFLICT",
        "upstream_design_conflict": "UPSTREAM_DESIGN_CONFLICT",
        "environment_blocker": "ENVIRONMENT_BLOCKER",
        "scope_conflict": "SCOPE_CONFLICT",
        "verification_goal_unclear": "VERIFICATION_GOAL_UNCLEAR",
    }
    if normalized in direct:
        return direct[normalized]

    lowered_error = raw_error.lower()
    if "document delta" in lowered_error or "stale document" in lowered_error:
        return "DOCUMENT_DELTA_CONFLICT"
    if "scope conflict" in lowered_error or "out of scope" in lowered_error:
        return "SCOPE_CONFLICT"
    if "verification goal unclear" in lowered_error:
        return "VERIFICATION_GOAL_UNCLEAR"
    if "e2e" in lowered_error and (
        "unclear" in lowered_error or "ambiguous" in lowered_error
    ):
        return "UNCLEAR_E2E_GOAL"
    if any(
        marker in lowered_error
        for marker in (
            "requirements",
            "upstream",
            "architecture",
            "technical decision",
            "ddd design",
            "event storming",
        )
    ):
        return "UPSTREAM_DESIGN_CONFLICT"
    if any(
        marker in lowered_error
        for marker in ("environment", "unavailable", "timed out", "binary not found")
    ):
        return "ENVIRONMENT_BLOCKER"
    return "UNCLEAR_E2E_GOAL"


def _decision_route(step: Step, decision: str) -> str:
    metadata_key_by_decision = {
        "IMPLEMENTATION_FAILURE": "on_implementation_failure",
        "UNCLEAR_E2E_GOAL": "on_unclear_e2e_goal",
        "DOCUMENT_DELTA_CONFLICT": "on_document_delta_conflict",
        "UPSTREAM_DESIGN_CONFLICT": "on_upstream_design_failure",
        "ENVIRONMENT_BLOCKER": "on_environment_blocker",
        "SCOPE_CONFLICT": "on_scope_conflict",
        "VERIFICATION_GOAL_UNCLEAR": "on_verification_goal_unclear",
    }
    defaults = {
        "IMPLEMENTATION_FAILURE": "remediation",
        "UNCLEAR_E2E_GOAL": "e2e-goal-approval",
        "DOCUMENT_DELTA_CONFLICT": "change-set-revision",
        "UPSTREAM_DESIGN_CONFLICT": "upstream-design-stage",
        "ENVIRONMENT_BLOCKER": "environment",
        "SCOPE_CONFLICT": "change-set-revision",
        "VERIFICATION_GOAL_UNCLEAR": "verification-goal-approval",
    }
    key = metadata_key_by_decision.get(decision, "")
    return _metadata_string(step, key) or defaults.get(decision, "blocked")


def _decision_owner_stage(decision: str) -> str:
    return {
        "IMPLEMENTATION_FAILURE": "executor",
        "UNCLEAR_E2E_GOAL": "e2e-goal-approval",
        "DOCUMENT_DELTA_CONFLICT": "change-set",
        "UPSTREAM_DESIGN_CONFLICT": "upstream-design",
        "ENVIRONMENT_BLOCKER": "environment",
        "SCOPE_CONFLICT": "change-set",
        "VERIFICATION_GOAL_UNCLEAR": "verification-goal",
    }.get(decision, "orchestrator")


def _decision_reason(decision: str, raw_error: str) -> str:
    prefix = {
        "IMPLEMENTATION_FAILURE": "implementation failure can return to remediation",
        "UNCLEAR_E2E_GOAL": "return to E2E goal approval gate",
        "DOCUMENT_DELTA_CONFLICT": "return to ChangeSet revision",
        "UPSTREAM_DESIGN_CONFLICT": "return to upstream design stage",
        "ENVIRONMENT_BLOCKER": "wait for environment recovery",
        "SCOPE_CONFLICT": "return to ChangeSet scope revision",
        "VERIFICATION_GOAL_UNCLEAR": "return to verification goal approval",
    }.get(decision, "decision blocked")
    detail = _first_line(raw_error)
    return f"{prefix}: {detail}" if detail else prefix


def _decision_failure_kind(decision: str) -> FailureKind | None:
    return {
        "IMPLEMENTATION_FAILURE": FailureKind.IMPLEMENTATION,
        "UNCLEAR_E2E_GOAL": FailureKind.UNCLEAR_E2E_GOAL,
        "DOCUMENT_DELTA_CONFLICT": FailureKind.DOCUMENT_DELTA_CONFLICT,
        "UPSTREAM_DESIGN_CONFLICT": FailureKind.UPSTREAM_DESIGN,
        "ENVIRONMENT_BLOCKER": FailureKind.ENVIRONMENT_BLOCKER,
        "SCOPE_CONFLICT": FailureKind.SCOPE_CONFLICT,
        "VERIFICATION_GOAL_UNCLEAR": FailureKind.VERIFICATION_GOAL_UNCLEAR,
    }.get(decision)


def _metadata_string(step: Step, key: str) -> str | None:
    value = step.metadata.get(key)
    return value if isinstance(value, str) and value else None


def _write_decision_evidence(
    step: Step,
    context: RunContext,
    step_dir: Path,
    decision: Mapping[str, Any],
) -> Path:
    evidence = step_dir / "decision.json"
    evidence.write_text(
        json.dumps(
            {
                "step_id": step.id,
                "work_item_id": context.metadata.get("active_work_item_id"),
                "change_set_id": context.metadata.get("change_set_id"),
                **dict(decision),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return evidence


def _decision_result_from_file(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


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


def _is_use_case_planner_step(step: Step) -> bool:
    if step.id == "planner-create-use-case-plan":
        return True
    return step.metadata.get("stage") == "planner" and step.metadata.get("scope") == "use_case"


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


def _append_runtime_remediation_task(
    step: Step,
    context: RunContext,
    step_dir: Path,
) -> StepResult:
    plan_path = _runtime_remediation_plan_path(step, context)
    if plan_path is None:
        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            error="remediation plan path is required",
            failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
        )

    absolute_plan_path = context.repo_root / plan_path
    if not absolute_plan_path.exists():
        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            error=f"missing remediation plan: {plan_path}",
            failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
        )

    retry_count = _context_string(context, "runtime_retry_count") or "1"
    failed_step_id = _context_string(context, "runtime_failed_step_id") or "verification"
    failure_kind = _context_string(context, "runtime_failure_kind") or "implementation"
    error = _first_line(_context_string(context, "runtime_failure_error") or "")
    task = (
        "\n"
        "## Runtime Remediation\n\n"
        f"- [ ] Retry {retry_count}: fix `{failed_step_id}` ({failure_kind})"
    )
    if error:
        task += f" - {error}"
    task += "\n"

    absolute_plan_path.write_text(
        absolute_plan_path.read_text(encoding="utf-8").rstrip() + task,
        encoding="utf-8",
    )
    evidence = step_dir / "remediation.json"
    evidence.write_text(
        json.dumps(
            {
                "step_id": step.id,
                "plan_path": str(plan_path),
                "retry_count": retry_count,
                "failed_step_id": failed_step_id,
                "failure_kind": failure_kind,
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
        output_path=_relative_to_repo(evidence, context),
    )


def _runtime_remediation_plan_path(step: Step, context: RunContext) -> Path | None:
    if step.outputs:
        return step.outputs[0]
    active_plan = _context_string(context, "active_plan_path")
    if active_plan:
        return Path(active_plan)
    return context.active_plan_path


def _first_line(value: str) -> str:
    return value.strip().splitlines()[0][:240] if value.strip() else ""


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
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith(prefix):
            return stripped[len(prefix) :].strip()
    return None


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
        return "active"
    if output.name in {"event-storming.md", "ddd-design.md", "technical-decisions.md"}:
        return "ready"
    return ""


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
