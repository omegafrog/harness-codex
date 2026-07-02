from pathlib import Path

from harness_codex.runtime.models import FailureKind, RunContext, RunMode
from harness_codex.runtime.plan_mutation_guard import (
    plan_mutation_request_for_context,
    validate_plan_mutation,
)


def test_plan_mutation_guard_allows_checked_checkbox_reset_for_current_run_rewrite() -> None:
    before = "\n".join(
        [
            "# 구현 계획",
            "",
            "## 작업 체크리스트",
            "",
            "- [x] TASK-001 구현 완료",
            "- [ ] TASK-002 남은 작업",
        ]
    )
    after = before.replace("- [x] TASK-001", "- [ ] TASK-001")

    result = validate_plan_mutation(
        before=before,
        after=after,
        request={
            "mode": "repair",
            "allowed_sections": ["작업 체크리스트"],
            "rewrite_checklist_for_current_run": True,
        },
    )

    assert result.passed
    assert result.report["checked_checkbox_resets"] == ["TASK-001"]


def test_plan_mutation_guard_blocks_out_of_allowlist_section_edits() -> None:
    before = "\n".join(
        [
            "# 구현 계획",
            "",
            "## 구현 목표",
            "",
            "- old goal",
            "",
            "## 집중 검증",
            "",
            "- [ ] VERIFY-001 test",
        ]
    )
    after = before.replace("- old goal", "- new goal")

    result = validate_plan_mutation(
        before=before,
        after=after,
        request={
            "mode": "patch_only",
            "allowed_sections": ["집중 검증"],
        },
    )

    assert not result.passed
    assert "구현 목표" in result.message


def test_plan_mutation_guard_allows_small_allowed_section_patch() -> None:
    before = "\n".join(
        [
            "# 구현 계획",
            "",
            "## 집중 검증",
            "",
            "- [ ] VERIFY-001 old command",
        ]
    )
    after = before.replace("old command", "new focused command")

    result = validate_plan_mutation(
        before=before,
        after=after,
        request={
            "mode": "patch_only",
            "allowed_sections": ["집중 검증"],
        },
    )

    assert result.passed


def test_plan_mutation_guard_allows_large_repair_when_rewrite_not_forbidden() -> None:
    before = "\n".join(
        [
            "# 구현 계획",
            "",
            "## 집중 검증",
            "",
            "- [ ] VERIFY-004 stale evidence",
        ]
    )
    after = "\n".join(
        [
            "# 구현 계획",
            "",
            "## 집중 검증",
            "",
            *[f"- 현재 실행 검증 절차 {index}" for index in range(160)],
        ]
    )

    result = validate_plan_mutation(
        before=before,
        after=after,
        request={
            "mode": "repair",
            "allowed_sections": ["집중 검증"],
            "forbid_full_rewrite": False,
        },
    )

    assert result.passed


def test_scope_conflict_mutation_request_forbids_scope_broadening() -> None:
    context = RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=Path("/repo"),
        workdir=Path("/repo"),
        run_dir=Path("/repo/.harness/runs/run-001"),
        metadata={
            "runtime_retry_count": 1,
            "runtime_failed_step_id": "verify-work-item",
            "runtime_failure_kind": FailureKind.SCOPE_CONFLICT.value,
            "runtime_failure_error": "scope conflict: notification/AGENTS.md",
            "runtime_failure_metadata": {
                "verification_report_path": ".harness/runs/run-001/work-items/UC-001/verification/report.json",
                "blocked_files": ["notification/AGENTS.md", ".semgrep/ddd-architecture.yml"],
            },
        },
    )

    request = plan_mutation_request_for_context(context)

    assert request is not None
    assert request["mode"] == "repair"
    assert request["preserve_checked_checkboxes"] is False
    assert request["rewrite_checklist_for_current_run"] is True
    assert request["forbid_full_rewrite"] is False
    assert request["forbid_scope_broadening"] is True
    assert request["evolve_allowed"] is False
    assert request["trigger_step"] == "verify-work-item"
    assert request["trigger_failure_kind"] == "scope_conflict"
    assert request["trigger_metadata"]["blocked_files"] == [
        "notification/AGENTS.md",
        ".semgrep/ddd-architecture.yml",
    ]
