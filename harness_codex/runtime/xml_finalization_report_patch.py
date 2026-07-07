"""Expose ChangeSet finalization status through an XML handoff."""

from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.xml_handoff import write_handoff

_PATCHED_ATTR = "_harness_xml_finalization_report_patch_applied"


def apply_xml_finalization_report_patch() -> None:
    """Keep raw finalization JSON as evidence but publish XML as the contract."""

    from harness_codex.runtime import changeset_orchestrator as module

    if getattr(module, _PATCHED_ATTR, False):
        return

    original = module._write_finalization_report

    def write_finalization_report(repo_root: Path, run_id: str, result) -> None:
        original(repo_root, run_id, result)
        path = repo_root / ".harness/runs" / run_id / "finalization" / "report.xml"
        write_handoff(
            path,
            "finalization-report",
            {
                "schema_version": 1,
                "workflow": module.FINALIZATION_WORKFLOW_NAME,
                "run_id": run_id,
                "status": result.status.value,
                "failed_step_id": result.failed_step_id,
                "failure_kind": result.failure_kind.value if result.failure_kind else None,
                "blocker": result.blocker,
                "delivery_status": result.metadata.get("delivery_status"),
                "step_results": [
                    {
                        "step_id": step.step_id,
                        "status": step.status.value,
                        "error": step.error,
                    }
                    for step in result.step_results
                ],
            },
        )

    module._write_finalization_report = write_finalization_report
    setattr(module, _PATCHED_ATTR, True)
