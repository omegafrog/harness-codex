"""Install XML-only readers for gates that decide workflow progress."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any, Mapping

_PATCHED_ATTR = "_harness_xml_gate_authority_patch_applied"


def apply_xml_gate_authority_patch() -> None:
    """Fail closed when a required canonical XML verdict is absent or invalid."""

    from harness_codex.runtime import completion, dashboard_runtime_state as canonical, engine
    from harness_codex.runtime.models import StepStatus
    from harness_codex.runtime.procedure_stages import PROCEDURE_STAGES
    from harness_codex.runtime.state import runtime_stage_projection
    from harness_codex.runtime.verification_failure import (
        VerificationFailureClass,
        structured_failure_from_report,
    )
    from harness_codex.runtime.xml_handoff import read_handoff
    from harness_codex.runtime.xml_state import load_run_state

    if getattr(engine.RunnerEngine, _PATCHED_ATTR, False):
        return

    def load_canonical_xml_state(repo_root: Path | str, change_set_id: str):
        try:
            return load_run_state(repo_root, canonical.canonical_run_id(change_set_id))
        except (FileNotFoundError, ValueError):
            return None

    def assert_xml_stage_gate(repo_root, change_set_id, target_stage_id, *, uc_id=None) -> None:
        del uc_id
        state = load_canonical_xml_state(repo_root, change_set_id)
        if state is None:
            raise ValueError(f"{target_stage_id} is blocked: canonical XML state is missing")
        stage_ids = [stage.stage_id for stage in PROCEDURE_STAGES]
        try:
            target_index = stage_ids.index(target_stage_id)
        except ValueError as exc:
            raise ValueError(f"unknown procedure stage: {target_stage_id}") from exc
        rows = runtime_stage_projection(state)
        incomplete = [
            stage_id
            for stage_id in stage_ids[:target_index]
            if rows.get(stage_id, {}).get("status") != "verified"
        ]
        if incomplete:
            raise ValueError(
                f"{target_stage_id} is blocked: canonical XML gates incomplete: "
                + ", ".join(incomplete)
            )

    def structured_verification_from_xml(self, step, context, result):
        if step.id != "verify-work-item" or result.status is not StepStatus.FAILED:
            return result
        work_item_id = str(context.metadata.get("active_work_item_id") or "")
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
        except ValueError as exc:
            return replace(
                result,
                status=StepStatus.BLOCKED,
                error=f"canonical verification XML is missing or invalid: {exc}",
                metadata={
                    **dict(result.metadata),
                    "verification_report_path": str(path.relative_to(context.repo_root)),
                    "verification_contract": "missing-or-invalid",
                },
            )
        failure = structured_failure_from_report(payload)
        if failure is None:
            return replace(
                result,
                status=StepStatus.BLOCKED,
                error="verification XML does not contain a structured failure verdict",
                metadata={
                    **dict(result.metadata),
                    "verification_report_path": str(path.relative_to(context.repo_root)),
                    "verification_contract": "incomplete",
                },
            )
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
            error=engine._verification_failure_error(result, failure),
            failure_kind=engine._failure_kind_for(failure.failure_class),
            metadata={
                **dict(result.metadata),
                "verification_report_path": str(path.relative_to(context.repo_root)),
                "verification_failure": failure.as_dict(),
            },
        )

    def load_execution_report_from_xml(
        repo_root: Path,
        *,
        relative_plan_path: Path,
        run_id: str | None,
        work_item_id: str | None,
    ) -> Mapping[str, Any] | None:
        item_id = work_item_id or completion._work_item_id_from_plan_path(relative_plan_path)
        if not run_id or not item_id:
            raise completion.PlanCompletionBlocked(
                "plan completion requires an explicit run id and work item id for XML verification"
            )
        execution_path = repo_root / ".harness/runs" / run_id / "work-items" / item_id / "execution-report.xml"
        verification_path = repo_root / ".harness/runs" / run_id / "work-items" / item_id / "verification/verification.xml"
        try:
            execution = read_handoff(execution_path, expected_type="execution-report")
            verification = read_handoff(verification_path, expected_type="verification-report")
            scope_path = Path(str(execution["execution_scope_path"]))
            scope = read_handoff(
                scope_path if scope_path.is_absolute() else repo_root / scope_path,
                expected_type="execution-scope",
            )
        except (KeyError, ValueError) as exc:
            raise completion.PlanCompletionBlocked(
                f"canonical XML execution evidence is missing or invalid: {exc}"
            ) from exc
        return {
            "plan_fingerprint": execution.get("plan_fingerprint"),
            "plan_path": scope.get("active_plan_path"),
            "work_item_id": execution.get("work_item_id"),
            "status": "completed" if verification.get("status") == "PASS" else "failed",
            "_verification_handoff": verification,
            "_source_run_id": run_id,
        }

    def validate_execution_report_from_xml(
        _repo_root: Path,
        report: Mapping[str, Any],
        *,
        relative_plan_path: Path,
        plan_text: str,
        run_id: str | None,
        work_item_id: str | None,
    ) -> None:
        expected_fingerprint = completion._plan_fingerprint(plan_text)
        if report.get("plan_fingerprint") != expected_fingerprint:
            raise completion.PlanCompletionBlocked("execution XML fingerprint does not match active plan")
        if str(report.get("plan_path", "")) != str(relative_plan_path):
            raise completion.PlanCompletionBlocked("execution XML plan path does not match active plan")
        if work_item_id and report.get("work_item_id") != work_item_id:
            raise completion.PlanCompletionBlocked("execution XML work item does not match selected work item")
        if run_id and report.get("_source_run_id") != run_id:
            raise completion.PlanCompletionBlocked("execution XML belongs to another run")
        verification = report.get("_verification_handoff")
        if not isinstance(verification, Mapping) or verification.get("status") != "PASS":
            raise completion.PlanCompletionBlocked("verification XML verdict is not PASS")

    canonical.load_canonical_change_set_state = load_canonical_xml_state
    canonical.assert_canonical_stage_gate = assert_xml_stage_gate
    engine.RunnerEngine._structured_verification_result = structured_verification_from_xml
    completion._load_execution_report = load_execution_report_from_xml
    completion._validate_execution_report = validate_execution_report_from_xml
    setattr(engine.RunnerEngine, _PATCHED_ATTR, True)
