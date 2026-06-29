"""Final canonical-authority guard for procedure stage gates."""

from __future__ import annotations

from pathlib import Path


_PATCHED = "_harness_canonical_stage_gate_authority_patch_applied"


def apply_canonical_stage_gate_authority_patch() -> None:
    """Reject explicit stale/blocked canonical decisions before legacy self-healing.

    Older compatibility code may use a verified Markdown row to bootstrap a state
    that has no explicit runtime decision. It must not use that row to replace an
    explicit `stale`, `blocked`, or `pending` decision already owned by RunState.
    """

    from harness_codex.runtime import dashboard_runtime_state as dashboard
    from harness_codex.runtime.procedure_stages import PROCEDURE_STAGES

    if getattr(dashboard, _PATCHED, False):
        return

    original_assert = dashboard.assert_canonical_stage_gate

    def assert_explicit_canonical_gate_first(
        repo_root: Path | str,
        change_set_id: str,
        target_stage_id: str,
        *,
        uc_id: str | None = None,
    ) -> None:
        state = dashboard.load_canonical_change_set_state(repo_root, change_set_id)
        if state is not None:
            stage_ids = [stage.stage_id for stage in PROCEDURE_STAGES]
            try:
                target_index = stage_ids.index(target_stage_id)
            except ValueError:
                target_index = 0
            decisions = state.decision_results.get("procedure_stage_results", {})
            if isinstance(decisions, dict):
                explicit_blockers = [
                    stage_id
                    for stage_id in stage_ids[:target_index]
                    if isinstance(decisions.get(stage_id), dict)
                    and decisions[stage_id].get("status") != "verified"
                ]
                if explicit_blockers:
                    raise ValueError(
                        f"{target_stage_id} is blocked: canonical runtime gates incomplete: "
                        + ", ".join(explicit_blockers)
                    )
        return original_assert(repo_root, change_set_id, target_stage_id, uc_id=uc_id)

    dashboard.assert_canonical_stage_gate = assert_explicit_canonical_gate_first
    setattr(dashboard, _PATCHED, True)
