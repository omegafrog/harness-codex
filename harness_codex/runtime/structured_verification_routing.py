"""Integrate verifier-report routing into the existing engine boundary.

The generic step runner must not execute a decision agent when a verifier has
already persisted a structured failure report. This adapter materializes that
decision as a durable run artifact and leaves only implementation failures
eligible for the remediation loop.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from harness_codex.runtime import engine as engine_module
from harness_codex.runtime.models import FailureKind, Step, StepKind, StepResult, StepStatus
from harness_codex.runtime.verification_failure import (
    VerificationFailureClass,
    structured_failure_from_report,
)


def apply_structured_verification_routing() -> None:
    """Install durable verifier-result routing once after the engine is imported."""

    if getattr(engine_module.RunnerEngine, "_structured_verification_routing_applied", False):
        return
    engine_module._failure_kind_for = _failure_kind_for
    engine_module.RunnerEngine._run_runtime_step = _run_runtime_step
    engine_module.RunnerEngine._structured_verification_routing_applied = True


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
    result = _structured_decision_result(step, runtime_context, failed_result)
    if result is None:
        result = self._step_runner.run(step, runtime_context)
    results.append(result)
    return result


def _structured_decision_result(
    step: Step,
    context: Any,
    failed_result: StepResult,
) -> StepResult | None:
    """Use a durable verifier report instead of asking a runner to classify it."""

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
    decision = {
        "classifier": "verification_result",
        "decision": failure.failure_class.name,
        "failure_class": failure.failure_class.value,
        "failed_step_id": failed_result.step_id,
        "source_failure_kind": (
            failed_result.failure_kind.value if failed_result.failure_kind is not None else None
        ),
        "route": failure.recommended_resume_target,
        "recommended_resume_target": failure.recommended_resume_target,
        "blocked": blocked,
        "owner_stage": failure.owner_stage,
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


def _write_decision_evidence(context: Any, step: Step, decision: dict[str, object]) -> Path:
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


def _relative_to_repo(path: Path, context: Any) -> Path:
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
        VerificationFailureClass.SECURITY_REVIEW_FAILURE: FailureKind.UNKNOWN,
        VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR: FailureKind.VERIFICATION_GOAL_UNCLEAR,
    }
    return mapping[failure_class]
