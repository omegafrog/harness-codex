"""Preserve canonical CLI stage decisions when dashboard state is saved."""

from __future__ import annotations

from dataclasses import replace


def apply_procedure_stage_runtime_state_preservation_patch() -> None:
    """Merge UI progress into, rather than replace, canonical procedure results."""

    try:
        from harness_codex.runtime import dashboard_runtime_state as dashboard
    except ImportError:
        return

    if getattr(dashboard, "_procedure_stage_result_preservation_patch_applied", False):
        return

    original = dashboard._build_canonical_state

    def build_canonical_state(*args, **kwargs):
        state = original(*args, **kwargs)
        current = kwargs.get("current")
        if current is None:
            return state

        existing = current.decision_results.get("procedure_stage_results", {})
        if not isinstance(existing, dict) or not existing:
            return state
        incoming = state.decision_results.get("procedure_stage_results", {})
        merged_decisions = dict(state.decision_results)
        merged_decisions["procedure_stage_results"] = {
            **existing,
            **(incoming if isinstance(incoming, dict) else {}),
        }
        return replace(state, decision_results=merged_decisions)

    dashboard._build_canonical_state = build_canonical_state
    dashboard._procedure_stage_result_preservation_patch_applied = True
