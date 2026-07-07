"""Execute a complete DDD candidate once per use case while preserving UI substeps."""

from __future__ import annotations

import json
from typing import Any


def apply_ddd_candidate_efficiency_patch() -> None:
    import harness_codex.runtime.harvest_ui as ui

    if getattr(ui, "_ddd_candidate_efficiency_patch_applied", False):
        return

    original_advance_all = ui._advance_all_ddd_architecture
    ui.DDD_RUN_ALL_TIMEOUT_SEC = ui.DDD_TIMEOUT_SEC

    def candidate_advance(
        root,
        session: dict[str, Any],
        change_set_id: str,
        *,
        uc_id: str | None = None,
        step_id: str | None = None,
    ) -> None:
        state = session["ddd_architecture"]
        target_uc = uc_id or _first_incomplete_uc(ui, state)
        if target_uc is None:
            ui._refresh_ddd_completion(state)
            session["runtime_error"] = ""
            return
        targets = _targets_for_uc(ui, state, target_uc)
        if targets:
            original_advance_all(root, session, change_set_id, targets)

    def candidate_advance_all(root, session: dict[str, Any], change_set_id: str, _targets) -> None:
        state = session["ddd_architecture"]
        for uc_id in state.get("uc_ids", []):
            targets = _targets_for_uc(ui, state, uc_id)
            if not targets:
                continue
            original_advance_all(root, session, change_set_id, targets)
            if state.get("status") in {"needs_input", "error"}:
                return
        ui._refresh_ddd_completion(state)
        session["runtime_error"] = ""

    def candidate_contract(change_set_id: str, targets, state: dict[str, Any]) -> str:
        uc_ids = sorted({str(target["uc_id"]) for target in targets})
        if len(uc_ids) != 1:
            raise ValueError("DDD candidate invocation must target exactly one use case")
        uc_id = uc_ids[0]
        item = state["items"][uc_id]
        answers = {
            step_id: value.get("clarifications", [])
            for step_id, value in item.get("steps", {}).items()
            if value.get("clarifications")
        }
        return f"""## DDD Candidate Execution

Target ChangeSet: {change_set_id}
Target Use Case: {uc_id}

Create or repair the complete candidate at `docs/use-cases/{uc_id}/ddd-design.md`
in this one turn. Use the selected `harness-ddd-design` skill as the authoritative
format contract. Do not generate code or edit `ARCHITECTURE.md`.

Complete all DDD sections together: Impact Assessment, Entity / Value Objects,
Behaviors, Application Flow, Aggregates, Bounded Contexts, Integration Impact,
and one cumulative Mermaid graph. Use the selected slice first; read baseline
artifacts only when that slice lacks evidence for reuse or modification.

Return JSON keys: status, questions, changed_files, blocker, impact,
completed_steps, current_target.
- `complete`: all five DDD sections are complete.
- `needs_input`: exactly one question; `current_target` names the blocking section.
- `blocked`: an upstream evidence gap cannot be resolved by one answer.

Prior answers:
{json.dumps(answers, ensure_ascii=False)}
"""

    ui._advance_ddd_architecture = candidate_advance
    ui._advance_all_ddd_architecture = candidate_advance_all
    ui._ddd_run_all_contract = candidate_contract
    ui._ddd_candidate_efficiency_patch_applied = True


def _first_incomplete_uc(ui, state: dict[str, Any]) -> str | None:
    for uc_id in state.get("uc_ids", []):
        if _targets_for_uc(ui, state, uc_id):
            return str(uc_id)
    return None


def _targets_for_uc(ui, state: dict[str, Any], uc_id: str) -> list[dict[str, str]]:
    steps = state["items"][uc_id]["steps"]
    return [
        {"uc_id": uc_id, "step_id": step_id, "label": label}
        for step_id, label in ui.DDD_STEPS
        if steps.get(step_id, {}).get("status") in {"pending", "running", "error", "stale"}
    ]
