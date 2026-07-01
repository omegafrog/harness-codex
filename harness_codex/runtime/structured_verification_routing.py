"""Route work-item verification failures from the verifier contract."""

from __future__ import annotations

from typing import Any

from harness_codex.runtime import engine as engine_module
from harness_codex.runtime.models import FailureKind, RunContext, Step, StepResult, StepStatus
from harness_codex.runtime.verification_failure import (
    VerificationFailure,
    VerificationFailureClass,
)


_ORIGINAL_ENGINE_RUN = engine_module.RunnerEngine.run
_ORIGINAL_STRUCTURED_VERIFICATION_RESULT = engine_module.RunnerEngine._structured_verification_result


def apply_structured_verification_routing() -> None:
    """Install verifier-owned recovery behavior once after engine import."""

    if getattr(engine_module.RunnerEngine, "_structured_verification_routing_applied", False):
        return

    engine_module._failure_kind_for = _failure_kind_for
    engine_module.RunnerEngine.run = _run_with_verifier_context
    engine_module.RunnerEngine._structured_verification_result = _structured_verification_result
    from harness_codex.runtime.verification_repair_dashboard_patch import install_verification_repair_dashboard_patch

    install_verification_repair_dashboard_patch()
    engine_module.RunnerEngine._structured_verification_routing_applied = True


def _run_with_verifier_context(self: Any, workflow: Any, context: RunContext) -> Any:
    return _ORIGINAL_ENGINE_RUN(self, workflow, context)


def _structured_verification_result(
    self: Any,
    step: Step,
    context: RunContext,
    result: StepResult,
) -> StepResult:
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
        from dataclasses import replace

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

    return _ORIGINAL_STRUCTURED_VERIFICATION_RESULT(self, step, context, result)


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


def _failure_kind_for(failure_class: VerificationFailureClass) -> FailureKind:
    mapping = {
        VerificationFailureClass.IMPLEMENTATION_FAILURE: FailureKind.IMPLEMENTATION,
        VerificationFailureClass.UNCLEAR_E2E_GOAL: FailureKind.UNCLEAR_E2E_GOAL,
        VerificationFailureClass.DOCUMENT_DELTA_CONFLICT: FailureKind.DOCUMENT_DELTA_CONFLICT,
        VerificationFailureClass.UPSTREAM_DESIGN_CONFLICT: FailureKind.UPSTREAM_DESIGN,
        VerificationFailureClass.ENVIRONMENT_BLOCKER: FailureKind.ENVIRONMENT_BLOCKER,
        VerificationFailureClass.SCOPE_CONFLICT: FailureKind.SCOPE_CONFLICT,
        VerificationFailureClass.SECURITY_REVIEW_FAILURE: FailureKind.IMPLEMENTATION,
        VerificationFailureClass.VERIFICATION_GOAL_UNCLEAR: FailureKind.VERIFICATION_GOAL_UNCLEAR,
    }
    return mapping[failure_class]
