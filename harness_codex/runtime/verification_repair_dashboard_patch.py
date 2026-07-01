"""Expose verifier-driven repair attempts in the ChangeSet dashboard."""

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
    runs_root = root / ".harness" / "runs"
    for path in runs_root.glob("**/verification/report.json"):
        event = _read_verification_report(path, change_set_id, work_item_ids)
        if event is not None:
            events.append(event)
    for path in runs_root.glob("**/security/security-review.md"):
        event = _read_security_review(path, change_set_id, work_item_ids)
        if event is not None:
            events.append(event)
    events.sort(key=lambda item: item["timestamp"])

    relevant = [item for item in events if item["decision"] != "VERIFICATION_PASSED"]
    last = relevant[-1] if relevant else None
    recovered_after_last_failure = bool(last and any(
        item["decision"] == "VERIFICATION_PASSED"
        and item["work_item_id"] == last["work_item_id"]
        and item["timestamp"] > last["timestamp"]
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


def _read_verification_report(path: Path, change_set_id: str, work_item_ids: set[str]) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict) or data.get("change_set_id") != change_set_id:
        return None
    work_item_id = str(data.get("work_item_id") or "")
    if work_item_ids and work_item_id not in work_item_ids:
        return None
    status = str(data.get("status") or "")
    failure_class = str(data.get("failure_class") or "")
    decision = "VERIFICATION_PASSED" if status == "PASS" else failure_class.upper()
    return {
        "timestamp": path.stat().st_mtime,
        "work_item_id": work_item_id,
        "decision": decision,
        "failure_class": failure_class,
        "failed_step_id": "verify-work-item-security"
        if failure_class == "security_review_failure"
        else "verify-work-item",
        "route": str(data.get("recommended_resume_target") or ""),
        "owner_stage": str(data.get("owner_stage") or ""),
        "retry_count": _retry_count_for_report(path),
        "reason": str(data.get("blocker") or ""),
        "evidence": [str(item) for item in data.get("evidence", []) if str(item)],
    }


def _read_security_review(path: Path, change_set_id: str, work_item_ids: set[str]) -> dict[str, Any] | None:
    work_item_id = _work_item_id_from_run_path(path)
    if work_item_ids and work_item_id not in work_item_ids:
        return None
    run_report_path = path.parents[3] / "report.json"
    try:
        report = json.loads(run_report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        report = {}
    if isinstance(report, dict) and report.get("change_set_id") not in (None, change_set_id):
        return None
    text = path.read_text(encoding="utf-8", errors="replace")
    status = "approved" if "approved" in text.casefold() else "rejected"
    if status == "approved":
        decision = "VERIFICATION_PASSED"
        failure_class = ""
        route = ""
    else:
        decision = "SECURITY_REVIEW_FAILURE"
        failure_class = "security_review_failure"
        route = "prepare-plan-repair"
    return {
        "timestamp": path.stat().st_mtime,
        "work_item_id": work_item_id,
        "decision": decision,
        "failure_class": failure_class,
        "failed_step_id": "verify-work-item-security",
        "route": route,
        "owner_stage": "implementation-planner" if failure_class else "",
        "retry_count": _retry_count_for_report(path),
        "reason": "security review rejected" if failure_class else "",
        "evidence": [str(_relative_to_repo_from_harness_path(path))],
    }


def _work_item_id_from_run_path(path: Path) -> str:
    parts = path.parts
    for index, part in enumerate(parts):
        if part == "work-items" and index + 1 < len(parts):
            return parts[index + 1]
    return ""


def _retry_count_for_report(path: Path) -> int:
    retry_count = 0
    for retry_path in path.parents:
        attempt = retry_path / "steps" / "prepare-plan-repair" / "remediation.json"
        if attempt.exists():
            try:
                data = json.loads(attempt.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            retry_count = max(retry_count, int(data.get("retry_count") or 0))
    return retry_count


def _relative_to_repo_from_harness_path(path: Path) -> Path:
    parts = path.parts
    try:
        harness_index = parts.index(".harness")
    except ValueError:
        return path
    root = Path(*parts[:harness_index])
    try:
        return path.relative_to(root)
    except ValueError:
        return path


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
  const status = recovery.status === "recovered" ? "복구 완료" : recovery.status === "planner-retry" ? "계획 보정 후 재시도" : "차단";
  const flow = "검증 → 계획 보정 → 계획 검토 → 범위 확정 → 재구현";
  const summary = active
    ? `<p class="small"><strong>${escapeHtml(active.failure_class || active.decision)}</strong> · 실패 단계 <code>${escapeHtml(active.failed_step_id || "verification")}</code> · 경로 <code>${escapeHtml(active.route || "blocked")}</code> · 재시도 ${escapeHtml(active.retry_count || 0)}회</p>
       <p class="small">${escapeHtml(active.reason || "")}</p>
       ${(active.evidence || []).length ? `<p class="small">증거: ${(active.evidence || []).map((item) => `<code>${escapeHtml(item)}</code>`).join(" ")}</p>` : ""}`
    : '<p class="small">이전 실패를 보정한 뒤 후속 검증을 통과했습니다.</p>';
  const history = (recovery.history || []).map((item) => `<li><code>${escapeHtml(item.work_item_id || "work-item")}</code> · ${escapeHtml(item.decision)} → <code>${escapeHtml(item.route || "complete")}</code>${item.retry_count ? ` (재시도 ${escapeHtml(item.retry_count)}회)` : ""}</li>`).join("");
  return `<details class="implementation-job verification-recovery" open>
    <summary>실패 재처리: ${escapeHtml(status)}</summary>
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
