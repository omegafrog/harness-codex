"""Make RunnerEngine consume verification XML instead of report.json."""

from __future__ import annotations

from dataclasses import replace

_PATCHED_ATTR = "_harness_xml_verification_engine_patch_applied"


def apply_xml_verification_engine_patch() -> None:
    from harness_codex.runtime import engine as engine_module
    from harness_codex.runtime.models import StepStatus
    from harness_codex.runtime.verification_failure import (
        VerificationFailureClass,
        structured_failure_from_report,
    )
    from harness_codex.runtime.xml_handoff import read_handoff

    RunnerEngine = engine_module.RunnerEngine
    if getattr(RunnerEngine, _PATCHED_ATTR, False):
        return
    original = RunnerEngine._structured_verification_result

    def structured(self, step, context, result):
        if step.id != "verify-work-item" or result.status is not StepStatus.FAILED:
            return original(self, step, context, result)
        work_item_id = str(context.metadata.get("active_work_item_id") or "")
        if not work_item_id:
            return original(self, step, context, result)
        path = (
            context.repo_root
            / ".harness/runs"
            / context.run_id
            / "work-items"
            / work_item_id
            / "verification/verification.xml"
        )
        try:
            payload = read_handoff(path, expected_type="verification-report")
        except ValueError:
            return original(self, step, context, result)
        failure = structured_failure_from_report(payload)
        if failure is None:
            return result
        status = (
            StepStatus.FAILED
            if failure.failure_class
            in {
                VerificationFailureClass.IMPLEMENTATION_FAILURE,
                VerificationFailureClass.SECURITY_REVIEW_FAILURE,
            }
            else StepStatus.BLOCKED
        )
        return replace(
            result,
            status=status,
            error=engine_module._verification_failure_error(result, failure),
            failure_kind=engine_module._failure_kind_for(failure.failure_class),
            metadata={
                **dict(result.metadata),
                "verification_report_path": str(path.relative_to(context.repo_root)),
                "verification_failure": failure.as_dict(),
            },
        )

    RunnerEngine._structured_verification_result = structured
    setattr(RunnerEngine, _PATCHED_ATTR, True)
