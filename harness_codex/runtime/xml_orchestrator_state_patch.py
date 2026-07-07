"""Project verified XML handoffs into the canonical ChangeSet state."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from harness_codex.runtime.xml_handoff import read_handoff

_PATCHED_ATTR = "_harness_xml_orchestrator_state_patch_applied"


def apply_xml_orchestrator_state_patch() -> None:
    """Persist verifier summaries in RunState instead of reading report JSON later."""

    from harness_codex.runtime import changeset_orchestrator as module

    if getattr(module, _PATCHED_ATTR, False):
        return

    original = module._build_state

    def build_state(*args, **kwargs):
        state = original(*args, **kwargs)
        repo_root = Path(kwargs["repo_root"])
        run_id = str(kwargs["run_id"])
        reports: dict[str, dict] = {}
        for scope in kwargs["scopes"]:
            path = (
                repo_root
                / ".harness/runs"
                / run_id
                / "work-items"
                / scope.display_id
                / "verification"
                / "verification.xml"
            )
            try:
                reports[scope.display_id] = read_handoff(path, expected_type="verification-report")
            except ValueError:
                continue
        if not reports:
            return state
        work_items = tuple(
            replace(
                item,
                verification_status=str(reports[item.work_item_id].get("status", item.verification_status)),
                last_verifier_result=reports[item.work_item_id],
            )
            if item.work_item_id in reports else item
            for item in state.work_item_states
        )
        use_cases = tuple(
            replace(
                item,
                verification_status=str(reports[item.uc_id].get("status", item.verification_status)),
                last_verifier_result=reports[item.uc_id],
            )
            if item.uc_id in reports else item
            for item in state.use_case_states
        )
        decisions = dict(state.decision_results)
        decisions["verification_handoffs"] = {
            work_item_id: {
                "path": f".harness/runs/{run_id}/work-items/{work_item_id}/verification/verification.xml",
                "status": payload.get("status"),
            }
            for work_item_id, payload in reports.items()
        }
        return replace(
            state,
            decision_results=decisions,
            work_item_states=work_items,
            use_case_states=use_cases,
        )

    module._build_state = build_state
    setattr(module, _PATCHED_ATTR, True)
