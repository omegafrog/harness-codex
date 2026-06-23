"""Structured verification routing integration."""

from __future__ import annotations

from typing import Any

from harness_codex.runtime import engine as engine_module
from harness_codex.runtime.models import FailureKind, Step, StepKind, StepResult, StepStatus
from harness_codex.runtime.verification_failure import (
    VerificationFailureClass,
    structured_failure_from_report,
)


def apply_verification_routing_engine_patch() -> None:
    if getattr(engine_module.RunnerEngine, "_verification_routing_patch_applied", False):
        return
    engine_module._failure_kind_for = _failure_kind_for
    engine_module.RunnerEngine._run_runtime_step = _run_runtime_step
    engine_module.RunnerEngine._verification_routing_patch_applied = True


def _run_runtime_step(
    self: Any,
    step: Step,
    context: Any,
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
    result = _structured_decision_result(step, failed_result)
    if result is None:
        result = self._step_runner.run(step, runtime_context)
    results.append(result)
    return result


def _structured_decision_result(
    step: Step,
    failed_result: StepResult,
) -> StepResult | None:
    if step.kind != StepKind.DECISION:
        return None
    raw_failure = failed_result.metadata.get("verification_failure")
    if not isinstance(raw_failure, dict):
        return None
    failure = structured_failure_from_report(raw_failure)
    if failure is None:
        return None

    blocked = failure.failure_class is not VerificationFailureClass.IMPLEMENTATION_FAILURE
    reason = (
        f"verification classified as {failure.failure_class.value}; "
        f"resume at {failure.recommended_resume_target}"
    )
    return StepResult(
        step_id=step.id,
        status=StepStatus.BLOCKED if blocked else StepStatus.SUCCEEDED,
        error=reason if blocked else None,
        failure_kind=_failure_kind_for(failure.failure_class) if blocked else None,
        metadata={
            "decision": {
                "classifier": "verification_result",
                "decision": failure.failure_class.name,
                "failed_step_id": failed_result.step_id,
                "source_failure_kind": (
                    failed_result.failure_kind.value
                    if failed_result.failure_kind is not None
                    else None
                ),
                "route": failure.recommended_resume_target,
                "blocked": blocked,
                "owner_stage": failure.owner_stage,
                "reason": reason,
                "evidence": list(failure.evidence),
            }
        },
    )


def _failure_kind_for(failure_class: VerificationFailureClass) -> FailureKind:
    mapping = {
        VerificationFailureClass.IMPLEMENTATION_FAILURE: FailureKind.IMPLEMENTATION,
        VerificationFailureClass.UNCLEAR_E2E_GOAL: FailureKind.UNCLEAR_E2E_GOAL,
        VerificationFailureClass.DOCUMENT_DELTA_CONFLICT: FailureKind.DOCUMENT_DELTA_CONFLICT,
        VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT: FailureKind.UPSTREAM_DESIGN,
        VerificationFailureClass.ENVIRONMENT_BLOCKER: FailureKind.ENVIRONMENT_BLOCKER,
        VerificationFailureClass.SCOPE_CONFLICT: FailureKind.SCOPE_CONFLICT,
        VerificationFailureClass.SECURITY_REVIEW_FAILURE: FailureKind.UNKNOWN,
        VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR: FailureKind.VERIFICATION_GOAL_UNCLEAR,
    }
    return mapping[failure_class]
