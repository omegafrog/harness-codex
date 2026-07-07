"""XML-backed status derivation helpers."""

from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.state import RunStateStore


def verification_routing_from_xml(
    repo_root: Path | str,
    run_id: str,
    work_item_id: str,
) -> dict[str, str]:
    try:
        state = RunStateStore(repo_root).load(run_id)
    except (FileNotFoundError, ValueError):
        return {}
    result = next(
        (item.last_verifier_result for item in state.work_item_states if item.work_item_id == work_item_id),
        None,
    )
    if result is None:
        result = next(
            (item.last_verifier_result for item in state.use_case_states if item.uc_id == work_item_id),
            {},
        )
    if not isinstance(result, dict):
        return {}
    return {
        key: value
        for key in ("failure_class", "owner_stage", "recommended_resume_target")
        if isinstance((value := result.get(key)), str)
    }
