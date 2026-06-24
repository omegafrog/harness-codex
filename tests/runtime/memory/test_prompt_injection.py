from pathlib import Path

from harness_codex.runtime.changeset_memory import render_stage_memory_context


def _write_memory(
    root: Path,
    *,
    memory_id: str,
    change_set_id: str,
    applies_to: tuple[str, ...],
) -> None:
    path = root / "docs/memory/completed-changes" / f"{memory_id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            [
                "---",
                f"memory_id: {memory_id}",
                "kind: completed_changeset",
                f"source_path: docs/changes/completed/{change_set_id}.md",
                f"change_set_id: {change_set_id}",
                "work_item_id: UC-010",
                "status: verified",
                "repository_revision: historical-revision",
                "tags:",
                "  - plan",
                "  - use_case",
                "applies_to:",
                *[f"  - {stage}" for stage in applies_to],
                "created_at: '2026-06-24'",
                "---",
                "",
                "Use completed artifacts as historical planning evidence.",
            ]
        ),
        encoding="utf-8",
    )


def test_only_designated_work_item_steps_receive_memory_context(tmp_path: Path) -> None:
    _write_memory(
        tmp_path,
        memory_id="MEM-20260624-020",
        change_set_id="CHG-020",
        applies_to=("plan", "execute", "verify"),
    )

    plan = render_stage_memory_context(
        repo_root=tmp_path,
        step_id="plan-work-item",
        change_set_id="CHG-NEW",
        work_item_id="UC-999",
        work_item_type="use_case",
    )
    execute = render_stage_memory_context(
        repo_root=tmp_path,
        step_id="execute-work-item",
        change_set_id="CHG-NEW",
        work_item_id="UC-999",
        work_item_type="use_case",
    )
    verify = render_stage_memory_context(
        repo_root=tmp_path,
        step_id="verify-work-item",
        change_set_id="CHG-NEW",
        work_item_id="UC-999",
        work_item_type="use_case",
    )
    complete = render_stage_memory_context(
        repo_root=tmp_path,
        step_id="complete-work-item-plan",
        change_set_id="CHG-NEW",
        work_item_id="UC-999",
        work_item_type="use_case",
    )

    for context in (plan, execute, verify):
        assert "Memory is historical reference only" in context
        assert "MEM-20260624-020" in context
        assert "Precedence: active ChangeSet/work item" in context
    assert complete == "No long-term memory is injected for this workflow step."


def test_same_active_changeset_memory_is_visible_as_blocked_but_not_injected(
    tmp_path: Path,
) -> None:
    _write_memory(
        tmp_path,
        memory_id="MEM-20260624-021",
        change_set_id="CHG-021",
        applies_to=("plan",),
    )

    context = render_stage_memory_context(
        repo_root=tmp_path,
        step_id="plan-work-item",
        change_set_id="CHG-021",
        work_item_id="UC-010",
        work_item_type="use_case",
    )

    assert "Matching memory was blocked by the ChangeSet precedence policy." in context
    assert "MEM-20260624-021" not in context
    assert "Use completed artifacts as historical planning evidence." not in context
