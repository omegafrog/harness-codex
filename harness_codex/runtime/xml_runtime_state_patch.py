"""Eliminate verification-report JSON from runtime resume state."""

from __future__ import annotations

from dataclasses import replace

_PATCHED_ATTR = "_harness_xml_runtime_state_patch_applied"


def apply_xml_runtime_state_patch() -> None:
    """Resolve environment blockers from XML-backed verifier metadata only."""

    from harness_codex.runtime import state as module
    from harness_codex.runtime.xml_verification_engine_patch import (
        apply_xml_verification_engine_patch,
    )

    Store = module.RunStateStore
    if getattr(Store, _PATCHED_ATTR, False):
        return

    def reconcile(self: Store, run_id: str):
        state = self.load(run_id)
        if state.failure_kind is not module.RunFailureKind.ENVIRONMENT_BLOCKER:
            return state
        work_item_id = state.current_work_item_id or state.current_use_case_id
        if not work_item_id:
            return state
        report = next(
            (
                item.last_verifier_result
                for item in state.work_item_states
                if item.work_item_id == work_item_id
            ),
            None,
        )
        if report is None:
            report = next(
                (
                    item.last_verifier_result
                    for item in state.use_case_states
                    if item.uc_id == work_item_id
                ),
                {},
            )
        if not isinstance(report, dict) or report.get("status") != "PASS":
            return state

        completed_work_items = module._append_unique(
            module._remove_item(state.completed_work_items, work_item_id),
            work_item_id,
        )
        completed_use_cases = state.completed_use_cases
        blocked_use_cases = state.blocked_use_cases
        if work_item_id in state.affected_use_cases:
            completed_use_cases = module._append_unique(
                module._remove_item(completed_use_cases, work_item_id),
                work_item_id,
            )
            blocked_use_cases = module._remove_item(blocked_use_cases, work_item_id)
        all_items = tuple(state.affected_work_items or state.affected_use_cases)
        all_completed = all(
            item in completed_work_items or item in completed_use_cases
            for item in all_items
        )
        updated = replace(
            state,
            completed_use_cases=completed_use_cases,
            completed_work_items=completed_work_items,
            blocked_use_cases=blocked_use_cases,
            blocked_work_items=module._remove_item(state.blocked_work_items, work_item_id),
            failed_step_id=None,
            failure_kind=None,
            status=module.RunStatus.SUCCEEDED if all_completed else module.RunStatus.RUNNING,
            current_step_id=module.UseCaseStep.COMPLETE if all_completed else state.current_step_id,
            use_case_states=tuple(
                module._resolved_use_case_state(item, report)
                if item.uc_id == work_item_id else item
                for item in state.use_case_states
            ),
            work_item_states=tuple(
                module._resolved_work_item_state(item, report)
                if item.work_item_id == work_item_id else item
                for item in state.work_item_states
            ),
        )
        self.save(updated)
        return updated

    Store.reconcile_resolved_environment_blocker = reconcile
    apply_xml_verification_engine_patch()
    setattr(Store, _PATCHED_ATTR, True)
