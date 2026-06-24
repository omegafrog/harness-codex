from pathlib import Path

import json

import pytest

from harness_codex.runtime.changeset_memory import (
    ChangeSetMemoryError,
    create_verified_memory_document,
    rebuild_memory_index,
    render_stage_memory_context,
    search_memory,
)


def _write_memory(
    root: Path,
    *,
    memory_id: str = "MEM-20260624-001",
    change_set_id: str = "CHG-100",
    work_item_id: str = "UC-010",
    revision: str = "current-revision",
    applies_to: tuple[str, ...] = ("plan", "verify"),
) -> None:
    target = root / "docs/memory/completed-changes" / f"{memory_id}.md"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        "\n".join(
            [
                "---",
                f"memory_id: {memory_id}",
                "kind: completed_changeset",
                "source_path: docs/changes/completed/CHG-100.md",
                f"change_set_id: {change_set_id}",
                f"work_item_id: {work_item_id}",
                "status: verified",
                f"repository_revision: {revision}",
                "tags:",
                "  - workflow-materialization",
                "  - placeholder-validation",
                "applies_to:",
                *[f"  - {stage}" for stage in applies_to],
                "created_at: 2026-06-24",
                "---",
                "",
                "Validate materialized workflow placeholders before planning and verification.",
            ]
        ),
        encoding="utf-8",
    )


def test_rebuild_index_uses_human_reviewed_documents_as_source_of_truth(tmp_path: Path) -> None:
    _write_memory(tmp_path)

    index_path = rebuild_memory_index(tmp_path)

    assert index_path == tmp_path / ".harness/memory-index/memory-index.json"
    payload = json.loads(index_path.read_text(encoding="utf-8"))
    assert payload["documents"][0]["memory_id"] == "MEM-20260624-001"
    assert payload["documents"][0]["source_path"] == "docs/changes/completed/CHG-100.md"


def test_search_returns_metadata_and_bm25_ranking_reasons(tmp_path: Path) -> None:
    _write_memory(tmp_path)

    hits = search_memory(
        tmp_path,
        "workflow placeholder validation",
        change_set_id="CHG-100",
        work_item_id="UC-010",
    )

    assert len(hits) == 1
    hit = hits[0]
    assert hit.document.kind == "completed_changeset"
    assert hit.document.source_path == Path("docs/changes/completed/CHG-100.md")
    assert hit.document.repository_revision == "current-revision"
    assert hit.reference_only is True
    assert any(reason.startswith("bm25=") for reason in hit.rank_reasons)


def test_stage_context_injects_only_for_plan_execute_and_verify(tmp_path: Path) -> None:
    _write_memory(tmp_path, revision="not-current")

    plan_context = render_stage_memory_context(
        repo_root=tmp_path,
        step_id="plan-work-item",
        change_set_id="CHG-101",
        work_item_id="UC-010",
        work_item_type="use_case",
    )
    complete_context = render_stage_memory_context(
        repo_root=tmp_path,
        step_id="complete-work-item-plan",
        change_set_id="CHG-101",
        work_item_id="UC-010",
        work_item_type="use_case",
    )

    assert "historical reference only" in plan_context.lower()
    assert "Revision:" in plan_context
    assert complete_context == "No long-term memory is injected for this workflow step."


def test_same_active_changeset_memory_is_blocked_from_authoritative_use(tmp_path: Path) -> None:
    _write_memory(tmp_path, change_set_id="CHG-101")

    hits = search_memory(
        tmp_path,
        "placeholder validation",
        current_change_set_id="CHG-101",
    )

    assert hits[0].confidence == "blocked"
    assert hits[0].blocked_reason == "same_active_changeset"


def test_memory_writer_rejects_active_changeset_source(tmp_path: Path) -> None:
    with pytest.raises(ChangeSetMemoryError, match="active ChangeSet"):
        create_verified_memory_document(
            tmp_path,
            memory_id="MEM-20260624-002",
            kind="decision",
            source_path="docs/changes/active/CHG-101.md",
            change_set_id="CHG-101",
            work_item_id="UC-010",
            repository_revision="abc123",
            tags=("safety",),
            body="Do not persist active ChangeSet text as long-term memory.",
        )


def test_memory_writer_creates_verified_document_and_regenerates_index(tmp_path: Path) -> None:
    target = create_verified_memory_document(
        tmp_path,
        memory_id="MEM-20260624-003",
        kind="review_learning",
        source_path="docs/changes/completed/CHG-101.md",
        change_set_id="CHG-101",
        work_item_id="UC-010",
        repository_revision="abc123",
        tags=("review", "verification"),
        applies_to=("verify",),
        body="Record only a reviewed learning from a completed verification.",
    )

    assert target.exists()
    assert (tmp_path / ".harness/memory-index/memory-index.json").exists()
    assert "status: verified" in target.read_text(encoding="utf-8")
