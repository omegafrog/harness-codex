from harness_codex.runtime.plan_mutation_guard import validate_plan_mutation


def test_plan_mutation_guard_blocks_checked_checkbox_reset() -> None:
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
            "mode": "patch_only",
            "allowed_sections": ["작업 체크리스트"],
            "preserve_checked_checkboxes": True,
        },
    )

    assert not result.passed
    assert "TASK-001" in result.message


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
