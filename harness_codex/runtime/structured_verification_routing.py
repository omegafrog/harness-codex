"""Route work-item verification failures through a durable classifier.

For classifier-enabled ChangeSet workflows, a verifier supplies evidence, the
classifier chooses the recovery owner, and only the implementation planner
mutates the active plan on a retry. Legacy graphs without the classifier retain
their existing generic engine behavior.
"""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from harness_codex.runtime import engine as engine_module
from harness_codex.runtime import runner as runner_module
from harness_codex.runtime.models import FailureKind, RunContext, Step, StepKind, StepResult, StepStatus
from harness_codex.runtime.verification_failure import (
    VerificationFailure,
    VerificationFailureClass,
    structured_failure_from_report,
)


_REPAIRABLE_FAILURES = {
    VerificationFailureClass.IMPLEMENTATION_FAILURE,
    VerificationFailureClass.SECURITY_REVIEW_FAILURE,
}


# Keep original methods before the patch replaces them. Generic workflows that
# do not declare the classifier must retain the older execution semantics.
_ORIGINAL_ENGINE_RUN = engine_module.RunnerEngine.run
_ORIGINAL_STRUCTURED_VERIFICATION_RESULT = engine_module.RunnerEngine._structured_verification_result
_ORIGINAL_RUN_AGENT = runner_module.BasicStepRunner._run_agent


def apply_structured_verification_routing() -> None:
    """Install classifier-first recovery behavior once after engine import."""

    if getattr(engine_module.RunnerEngine, "_structured_verification_routing_applied", False):
        return

    engine_module._failure_kind_for = _failure_kind_for
    engine_module.RunnerEngine.run = _run_with_classifier_context
    engine_module.RunnerEngine._run_runtime_step = _run_runtime_step
    engine_module.RunnerEngine._structured_verification_result = _structured_verification_result
    runner_module.BasicStepRunner._run_agent = _run_agent_with_scope_classifier
    from harness_codex.runtime.verification_repair_dashboard_patch import (
        install_verification_repair_dashboard_patch,
    )

    install_verification_repair_dashboard_patch()
    engine_module.RunnerEngine._structured_verification_routing_applied = True


def _run_with_classifier_context(self: Any, workflow: Any, context: RunContext) -> Any:
    """Mark only workflows that opt into the classifier-first recovery contract."""

    has_classifier = any(
        step.id == "classify-verification-result" and step.kind == StepKind.DECISION
        for step in workflow.steps
    )
    if has_classifier:
        context = replace(
            context,
            metadata={**dict(context.metadata), "classifier_first_recovery": True},
        )
    return _ORIGINAL_ENGINE_RUN(self, workflow, context)


def _run_agent_with_scope_classifier(
    self: Any,
    step: Step,
    context: RunContext,
    step_dir: Path,
) -> StepResult:
    """Make executor scope blocks visible to the classifier in opted-in workflows."""

    result = _ORIGINAL_RUN_AGENT(self, step, context, step_dir)
    if not context.metadata.get("classifier_first_recovery"):
        return result
    if (
        step.id != "execute-work-item"
        or result.status is not StepStatus.BLOCKED
        or result.metadata.get("scope_diff_status") != "blocked"
    ):
        return result

    report_path = str(result.metadata.get("scope_diff_report_path") or "")
    failure = VerificationFailure(
        failure_class=VerificationFailureClass.SCOPE_CONFLICT,
        owner_stage="changeset",
        recommended_resume_target="change-set-revision",
        evidence=(report_path,) if report_path else (),
    )
    return replace(
        result,
        status=StepStatus.FAILED,
        # Implementation permits the engine's remediation path to invoke the
        # classifier. The durable failure class below preserves the true cause.
        failure_kind=FailureKind.IMPLEMENTATION,
        metadata={
            **dict(result.metadata),
            "runtime_failure_class": failure.failure_class.value,
            "verification_failure": failure.as_dict(),
        },
    )


def _structured_verification_result(
    self: Any,
    step: Step,
    context: RunContext,
    result: StepResult,
) -> StepResult:
    """Use verifier/security-review evidence instead of generic shell failures."""

    if step.id == "verify-work-item-security" and result.status is StepStatus.FAILED:
        work_item_id = str(context.metadata.get("active_work_item_id") or "")
        security_review_path = (
            context.repo_root
            / ".harness"
            / "runs"
            / context.run_id
            / "work-items"
            / work_item_id
            / "security"
            / "security-review.md"
        )
        failure = VerificationFailure(
            failure_class=VerificationFailureClass.SECURITY_REVIEW_FAILURE,
            owner_stage="implementation-planner",
            recommended_resume_target="prepare-plan-repair",
            evidence=(str(security_review_path.relative_to(context.repo_root)),)
            if security_review_path.exists()
            else (),
        )
        return replace(
            result,
            error=result.error or "security review rejected",
            failure_kind=FailureKind.IMPLEMENTATION,
            metadata={
                **dict(result.metadata),
                "runtime_failure_class": failure.failure_class.value,
                "security_review_path": str(security_review_path.relative_to(context.repo_root)),
                "verification_failure": failure.as_dict(),
            },
        )

    structured = _ORIGINAL_STRUCTURED_VERIFICATION_RESULT(self, step, context, result)
    if (
        context.metadata.get("classifier_first_recovery")
        and structured.status is StepStatus.FAILED
        and structured.failure_kind is FailureKind.SCOPE_CONFLICT
        and isinstance(structured.metadata.get("verification_failure"), dict)
    ):
        return replace(
            structured,
            # Avoid the engine's legacy direct scope-restart shortcut. The
            # classifier receives the original scope failure below.
            failure_kind=FailureKind.IMPLEMENTATION,
            metadata={
                **dict(structured.metadata),
                "runtime_failure_class": VerificationFailureClass.SCOPE_CONFLICT.value,
            },
        )
    return structured


def _run_runtime_step(
    self: Any,
    step: Step,
    context: RunContext,
    results: list[StepResult],
    *,
    retry_count: int,
    failed_step: Step,
    failed_result: StepResult,
) -> StepResult:
    runtime_context = self._runtime_failure_context(
        context,
        retry_count=retry_count,
        failed_step=failed_step,
        failed_result=failed_result,
    )
    runtime_failure_class = failed_result.metadata.get("runtime_failure_class")
    if isinstance(runtime_failure_class, str) and runtime_failure_class:
        runtime_context = replace(
            runtime_context,
            metadata={
                **dict(runtime_context.metadata),
                "runtime_failure_kind": runtime_failure_class,
            },
        )
    result = _structured_decision_result(step, runtime_context, failed_result)
    if result is None:
        result = self._step_runner.run(step, runtime_context)
    results.append(result)
    return result


def _structured_decision_result(
    step: Step,
    context: RunContext,
    failed_result: StepResult,
) -> StepResult | None:
    """Persist a deterministic classifier decision from durable failure evidence."""

    if step.kind != StepKind.DECISION:
        return None
    raw_failure = failed_result.metadata.get("verification_failure")
    if not isinstance(raw_failure, dict):
        return None
    failure = structured_failure_from_report(raw_failure)
    if failure is None:
        return None

    route = _route_for_failure(step, failure.failure_class, failure.recommended_resume_target)
    repairable = failure.failure_class in _REPAIRABLE_FAILURES
    blocked = not repairable
    reason = f"verification classified as {failure.failure_class.value}; route to {route}"
    decision = {
        "classifier": "verification_result",
        "decision": failure.failure_class.name,
        "failure_class": failure.failure_class.value,
        "failed_step_id": failed_result.step_id,
        "source_failure_kind": (
            failed_result.failure_kind.value if failed_result.failure_kind is not None else None
        ),
        "route": route,
        "recommended_resume_target": route,
        "retry_count": context.metadata.get("runtime_retry_count", 0),
        "blocked": blocked,
        "owner_stage": "implementation-planner" if repairable else failure.owner_stage,
        "reason": reason,
        "evidence": list(failure.evidence),
    }
    evidence_path = _write_decision_evidence(context, step, decision)
    return StepResult(
        step_id=step.id,
        status=StepStatus.BLOCKED if blocked else StepStatus.SUCCEEDED,
        output_path=_relative_to_repo(evidence_path, context),
        error=reason if blocked else None,
        failure_kind=_failure_kind_for(failure.failure_class) if blocked else None,
        metadata={
            "decision": decision,
            "verification_failure": failure.as_dict(),
        },
    )


def _route_for_failure(
    step: Step,
    failure_class: VerificationFailureClass,
    fallback: str,
) -> str:
    metadata_key = {
        VerificationFailureClass.IMPLEMENTATION_FAILURE: "on_implementation_failure",
        VerificationFailureClass.SECURITY_REVIEW_FAILURE: "on_security_review_failure",
        VerificationFailureClass.UNCLEAR_E2E_GOAL: "on_unclear_e2e_goal",
        VerificationFailureClass.DOCUMENT_DELTA_CONFLICT: "on_document_delta_conflict",
        VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT: "on_upstream_design_failure",
        VerificationFailureClass.ENVIRONMENT_BLOCKER: "on_environment_blocker",
        VerificationFailureClass.SCOPE_CONFLICT: "on_scope_conflict",
        VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR: "on_verification_goal_unclear",
    }.get(failure_class)
    configured = step.metadata.get(metadata_key) if metadata_key else None
    if isinstance(configured, str) and configured:
        return configured
    return fallback


def _write_decision_evidence(context: RunContext, step: Step, decision: dict[str, object]) -> Path:
    path = context.run_dir / "steps" / step.id / "decision.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "step_id": step.id,
        "work_item_id": context.metadata.get("active_work_item_id"),
        "change_set_id": context.metadata.get("change_set_id"),
        **decision,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def _relative_to_repo(path: Path, context: RunContext) -> Path:
    try:
        return path.relative_to(context.repo_root)
    except ValueError:
        return path


def _failure_kind_for(failure_class: VerificationFailureClass) -> FailureKind:
    mapping = {
        VerificationFailureClass.IMPLEMENTATION_FAILURE: FailureKind.IMPLEMENTATION,
        VerificationFailureClass.UNCLEAR_E2E_GOAL: FailureKind.UNCLEAR_E2E_GOAL,
        VerificationFailureClass.DOCUMENT_DELTA_CONFLICT: FailureKind.DOCUMENT_DELTA_CONFLICT,
        VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT: FailureKind.UPSTREAM_DESIGN,
        VerificationFailureClass.ENVIRONMENT_BLOCKER: FailureKind.ENVIRONMENT_BLOCKER,
        VerificationFailureClass.SCOPE_CONFLICT: FailureKind.SCOPE_CONFLICT,
        # The classifier exposes the explicit security class in decision metadata.
        # FailureKind has no separate persisted enum member in older saved runs.
        VerificationFailureClass.SECURITY_REVIEW_FAILURE: FailureKind.IMPLEMENTATION,
        VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR: FailureKind.VERIFICATION_GOAL_UNCLEAR,
    }
    return mapping[failure_class]
