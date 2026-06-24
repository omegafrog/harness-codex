from pathlib import Path

import json

from harness_codex.runtime.changeset_memory import rebuild_memory_index, search_memory


def _write_memory(
    root: Path,
    *,
    memory_id: str,
    change_set_id: str,
    revision: str,
    body: str,
    applies_to: tuple[str, ...] = ("plan",),
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
                f"repository_revision: {revision}",
                "tags:",
                "  - workflow-materialization",
                "  - placeholder-validation",
                "applies_to:",
                *[f"  - {stage}" for stage in applies_to],
                "created_at: '2026-06-24'",
                "---",
                "",
                body,
            ]
        ),
        encoding="utf-8",
    )


def test_rebuild_index_contains_terms_and_document_digest(tmp_path: Path) -> None:
    _write_memory(
        tmp_path,
        memory_id="MEM-20260624-010",
        change_set_id="CHG-010",
        revision="abc123",
        body="Validate workflow materialization before execution.",
    )

    index_path = rebuild_memory_index(tmp_path)
    row = json.loads(index_path.read_text(encoding="utf-8"))["documents"][0]

    assert row["memory_id"] == "MEM-20260624-010"
    assert row["digest"]
    assert "workflow-materialization" in row["terms"]


def test_search_honors_metadata_filters_and_returns_ranking_evidence(tmp_path: Path) -> None:
    _write_memory(
        tmp_path,
        memory_id="MEM-20260624-011",
        change_set_id="CHG-011",
        revision="abc123",
        body="Placeholder validation protects workflow materialization.",
    )
    _write_memory(
        tmp_path,
        memory_id="MEM-20260624-012",
        change_set_id="CHG-012",
        revision="abc123",
        body="A different verification policy.",
        applies_to=("verify",),
    )

    hits = search_memory(
        tmp_path,
        "workflow-materialization placeholder-validation",
        change_set_id="CHG-011",
        stage="plan",
    )

    assert [hit.document.memory_id for hit in hits] == ["MEM-20260624-011"]
    assert hits[0].reference_only is True
    assert any(reason.startswith("bm25=") for reason in hits[0].rank_reasons)
    assert any(reason.startswith("matched=") for reason in hits[0].rank_reasons)


def test_current_changeset_memory_is_blocked_and_revision_mismatch_is_historical(
    tmp_path: Path, monkeypatch
) -> None:
    _write_memory(
        tmp_path,
        memory_id="MEM-20260624-013",
        change_set_id="CHG-013",
        revision="old-revision",
        body="Placeholder validation is historical evidence.",
    )
    monkeypatch.setattr(
        "harness_codex.runtime.changeset_memory.current_repository_revision",
        lambda root: "new-revision",
    )

    same_change = search_memory(
        tmp_path,
        "placeholder-validation",
        current_change_set_id="CHG-013",
    )
    historical = search_memory(tmp_path, "placeholder-validation")

    assert same_change[0].confidence == "blocked"
    assert same_change[0].blocked_reason == "same_active_changeset"
    assert historical[0].confidence == "historical"
    assert historical[0].blocked_reason == "revision_mismatch"


def test_search_rebuilds_a_stale_index_from_current_documents(tmp_path: Path) -> None:
    _write_memory(
        tmp_path,
        memory_id="MEM-20260624-014",
        change_set_id="CHG-014",
        revision="abc123",
        body="Original guidance.",
    )
    rebuild_memory_index(tmp_path)
    memory_path = tmp_path / "docs/memory/completed-changes/MEM-20260624-014.md"
    memory_path.write_text(
        memory_path.read_text(encoding="utf-8").replace(
            "Original guidance.", "Refreshed workflow-materialization guidance."
        ),
        encoding="utf-8",
    )

    hits = search_memory(tmp_path, "workflow-materialization")

    assert hits and hits[0].document.memory_id == "MEM-20260624-014"
