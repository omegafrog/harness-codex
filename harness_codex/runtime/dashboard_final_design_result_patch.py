"""Expose verified design-visualization artifacts in the dashboard final result."""

from __future__ import annotations

from pathlib import Path
from typing import Any


_PATCHED_ATTR = "_harness_dashboard_final_design_result_patch_applied"


def apply_dashboard_final_design_result_patch() -> None:
    """Add verified class/flow diagrams to the dashboard delivery payload."""

    try:
        from harness_codex.runtime import document_dashboard, ui_server
    except ImportError:
        return

    if getattr(document_dashboard, _PATCHED_ATTR, False):
        return

    original_dashboard_state = document_dashboard.document_dashboard_state

    def dashboard_state_with_final_design_results(repo_root: Path | str) -> dict[str, Any]:
        root = Path(repo_root)
        state = original_dashboard_state(root)
        for change_set in state.get("change_sets", []):
            if isinstance(change_set, dict):
                change_set["final_design_visualizations"] = _final_design_visualizations(
                    root, str(change_set.get("id") or ""), change_set.get("work_items", [])
                )
        return state

    document_dashboard.document_dashboard_state = dashboard_state_with_final_design_results
    ui_server.document_dashboard_state = dashboard_state_with_final_design_results
    setattr(document_dashboard, _PATCHED_ATTR, True)


def _final_design_visualizations(
    root: Path,
    change_set_id: str,
    work_items: Any,
) -> list[dict[str, Any]]:
    """Return only current, verified diagrams suitable for a final-result view."""

    from harness_codex.runtime.design_visualization import verify_design_visualization

    if not isinstance(work_items, list):
        return []
    results: list[dict[str, Any]] = []
    for item in work_items:
        if not isinstance(item, dict) or item.get("type") != "use_case":
            continue
        uc_id = str(item.get("id") or "")
        if not uc_id:
            continue
        slice_path = root / "docs/use-cases" / uc_id
        class_path = slice_path / "class-diagram.md"
        flow_path = slice_path / "flow-diagram.md"
        if not class_path.is_file() or not flow_path.is_file():
            continue
        verified, problems = verify_design_visualization(
            root,
            change_set_id=change_set_id,
            uc_id=uc_id,
        )
        results.append(
            {
                "uc_id": uc_id,
                "status": "verified" if verified else "stale",
                "problems": list(problems),
                "class_diagram": class_path.read_text(encoding="utf-8"),
                "flow_diagram": flow_path.read_text(encoding="utf-8"),
            }
        )
    return results
