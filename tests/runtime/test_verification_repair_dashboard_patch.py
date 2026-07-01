from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.verification_repair_dashboard_patch import (
    _patch_dashboard_script,
    _recovery_state,
)


def _write_decision(root: Path, *, decision: str, route: str, retry_count: int) -> None:
    path = root / ".harness/runs/run-1/work-items/UC-001/steps/classify-verification-result/decision.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "change_set_id": "CHG-001",
                "work_item_id": "UC-001",
                "decision": decision,
                "failure_class": "security_review_failure",
                "failed_step_id": "verify-work-item-security",
                "route": route,
                "owner_stage": "implementation-planner",
                "retry_count": retry_count,
                "reason": "security review rejected",
                "evidence": [".harness/runs/run-1/work-items/UC-001/security/security-review.md"],
            }
        ),
        encoding="utf-8",
    )


def test_recovery_projection_exposes_planner_retry_and_evidence(tmp_path: Path) -> None:
    change_set = tmp_path / "docs/changes/active/CHG-001.md"
    change_set.parent.mkdir(parents=True)
    change_set.write_text("# CHG-001\n", encoding="utf-8")
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("# plan\n", encoding="utf-8")
    _write_decision(
        tmp_path,
        decision="SECURITY_REVIEW_FAILURE",
        route="prepare-plan-repair",
        retry_count=1,
    )

    state = _recovery_state(tmp_path, "CHG-001")

    assert state["status"] == "planner-retry"
    assert state["attempt_count"] == 1
    assert state["active"]["failed_step_id"] == "verify-work-item-security"
    assert state["active"]["route"] == "prepare-plan-repair"
    assert state["active"]["evidence"] == [
        ".harness/runs/run-1/work-items/UC-001/security/security-review.md"
    ]


def test_dashboard_script_renders_korean_recovery_flow_once() -> None:
    script = '''function renderImplementationWorkspace() {
  return `<section class="panel implementation-actions">
      <h3>Implementation</h3>
    </section>`;
}'''

    patched = _patch_dashboard_script(script)

    assert "function renderImplementationRecovery(recovery)" in patched
    assert "검증 → 실패 분류 → 계획 보정 → 계획 검토 → 범위 확정 → 재구현" in patched
    assert "실패 재처리:" in patched
    assert "${renderImplementationRecovery(state?.recovery)}" in patched
    assert _patch_dashboard_script(patched) == patched
