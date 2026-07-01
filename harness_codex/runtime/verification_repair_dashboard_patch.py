"""Expose classifier-driven repair attempts in the ChangeSet dashboard."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


_PATCHED_ATTR = "_harness_verification_repair_dashboard_patch_applied"


def install_verification_repair_dashboard_patch() -> None:
    """Attach recovery state and JavaScript rendering to the existing UI patch."""

    from harness_codex.runtime import dashboard_ddd_integration_ui_patch as ddd_patch

    if getattr(ddd_patch, _PATCHED_ATTR, False):
        return

    original_apply = ddd_patch.apply_dashboard_ddd_integration_ui_patch

    def apply_with_verification_repair_ui() -> None:
        original_apply()
        _apply_runtime_state_projection()
        _apply_dashboard_script_projection(ddd_patch)

    ddd_patch.apply_dashboard_ddd_integration_ui_patch = apply_with_verification_repair_ui
    setattr(ddd_patch, _PATCHED_ATTR, True)


def _apply_runtime_state_projection() -> None:
    from harness_codex.runtime import ui_server

    if getattr(ui_server, _PATCHED_ATTR, False):
        return
    original = ui_server.implementation_progress_state

    def implementation_progress_with_recovery(repo_root: Path | str, change_set_id: str) -> dict[str, Any]:
        state = original(repo_root, change_set_id)
        state["recovery"] = _recovery_state(Path(repo_root).resolve(), change_set_id)
        return state

    ui_server.implementation_progress_state = implementation_progress_with_recovery
    setattr(ui_server, _PATCHED_ATTR, True)


def _apply_dashboard_script_projection(ddd_patch: Any) -> None:
    if getattr(ddd_patch, "_harness_verification_repair_script_patch_applied", False):
        return
    original = ddd_patch._patch_dashboard_script

    def patch_dashboard_script_with_recovery(script: str) -> str:
        return _patch_dashboard_script(original(script))

    ddd_patch._patch_dashboard_script = patch_dashboard_script_with_recovery
    setattr(ddd_patch, "_harness_verification_repair_script_patch_applied", True)


def _recovery_state(root: Path, change_set_id: str) -> dict[str, Any]:
    work_item_ids = _work_item_ids(root, change_set_id)
    events: list[dict[str, Any]] = []
    for path in (root / ".harness" / "runs").glob("**/steps/classify-verification-result/decision.json"):
        event = _read_decision(path, change_set_id, work_item_ids)
        if event is not None:
            events.append(event)
    events.sort(key=lambda item: item["timestamp"])

    relevant = [item for item in events if item["decision"] != "VERIFICATION_PASSED"]
    last = relevant[-1] if relevant else None
    recovered_after_last_failure = bool(last and any(
        item["decision"] == "VERIFICATION_PASSED" and item["timestamp"] > last["timestamp"]
        for item in events
    ))
    status = "recovered" if recovered_after_last_failure else _recovery_status(last)
    return {
        "status": status,
        "attempt_count": max((int(item.get("retry_count") or 0) for item in relevant), default=0),
        "active": None if recovered_after_last_failure else last,
        "history": [
            {key: value for key, value in item.items() if key != "timestamp"}
            for item in events[-8:]
        ],
    }


def _work_item_ids(root: Path, change_set_id: str) -> set[str]:
    change_set_path = root / "docs" / "changes" / "active" / f"{change_set_id}.md"
    if not change_set_path.is_file():
        return set()
    return {
        plan_path.parent.name
        for plan_path in (root / "docs" / "plans" / "active").glob("*/plan.md")
    }


def _read_decision(path: Path, change_set_id: str, work_item_ids: set[str]) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("change_set_id") != change_set_id:
        return None
    work_item_id = str(data.get("work_item_id") or "")
    if work_item_ids and work_item_id not in work_item_ids:
        return None
    decision = str(data.get("decision") or "")
    if not decision:
        return None
    return {
        "timestamp": path.stat().st_mtime,
        "work_item_id": work_item_id,
        "decision": decision,
        "failure_class": str(data.get("failure_class") or ""),
        "failed_step_id": str(data.get("failed_step_id") or ""),
        "route": str(data.get("route") or ""),
        "owner_stage": str(data.get("owner_stage") or ""),
        "retry_count": int(data.get("retry_count") or 0),
        "reason": str(data.get("reason") or ""),
        "evidence": [str(item) for item in data.get("evidence", []) if str(item)],
    }


def _recovery_status(event: dict[str, Any] | None) -> str:
    if event is None:
        return "idle"
    if event.get("route") == "prepare-plan-repair":
        return "planner-retry"
    return "blocked"


def _patch_dashboard_script(script: str) -> str:
    if "function renderImplementationRecovery(recovery)" in script:
        return script
    source = "function renderImplementationWorkspace() {"
    helper = '''function renderImplementationRecovery(recovery) {
  if (!recovery || recovery.status === "idle") return "";
  const active = recovery.active;
  const status = recovery.status === "recovered" ? "recovered" : recovery.status;
  const flow = "Verification → Classifier → Plan patch → Plan review → Scope → Implementation";
  const summary = active
    ? `<p class="small"><strong>${escapeHtml(active.failure_class || active.decision)}</strong> at <code>${escapeHtml(active.failed_step_id || "verification")}</code> · route <code>${escapeHtml(active.route || "blocked")}</code> · retry ${escapeHtml(active.retry_count || 0)}</p>
       <p class="small">${escapeHtml(active.reason || "")}</p>
       ${(active.evidence || []).length ? `<p class="small">Evidence: ${(active.evidence || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(" ")}</p>` : ""}`
    : "<p class=\"small\">A prior failed attempt was repaired and later verification passed.</p>";
  const history = (recovery.history || []).map((item) => `<li><code>${escapeHtml(item.work_item_id || "work-item")}</code> · ${escapeHtml(item.decision)} → <code>${escapeHtml(item.route || "complete")}</code>${item.retry_count ? ` (retry ${escapeHtml(item.retry_count)})` : ""}</li>`).join("");
  return `<details class="implementation-job verification-recovery" open>
    <summary>Failure recovery: ${escapeHtml(status)}</summary>
    <p class="small">${flow}</p>
    ${summary}
    ${history ? `<ol class="small">${history}</ol>` : ""}
  </details>`;
}

function renderImplementationWorkspace() {'''
    if source not in script:
        raise RuntimeError("dashboard.js compatibility patch could not find implementation workspace")
    patched = script.replace(source, helper, 1)
    source_heading = "      <h3>Implementation</h3>"
    target_heading = "      <h3>Implementation</h3>\n      ${renderImplementationRecovery(state?.recovery)}"
    if source_heading not in patched:
        raise RuntimeError("dashboard.js compatibility patch could not find implementation heading")
    return patched.replace(source_heading, target_heading, 1)
