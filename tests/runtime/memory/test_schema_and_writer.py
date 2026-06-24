from pathlib import Path

import pytest

from harness_codex.runtime.changeset_memory import (
    ChangeSetMemoryError,
    create_verified_memory_document,
    load_memory_documents,
)


def test_schema_rejects_unverified_memory_document(tmp_path: Path) -> None:
    document = tmp_path / "docs/memory/decisions/MEM-20260624-001.md"
    document.parent.mkdir(parents=True)
    document.write_text(
        "\n".join(
            [
                "---",
                "memory_id: MEM-20260624-001",
                "kind: decision",
                "source_path: docs/changes/completed/CHG-001.md",
                "status: candidate",
                "repository_revision: abc123",
                "tags:",
                "  - decision",
                "created_at: '2026-06-24'",
                "---",
                "Not verified yet.",
            ]
        ),
        encoding="utf-8",
    )

    with pytest.raises(ChangeSetMemoryError, match="verified"):
        load_memory_documents(tmp_path)


def test_writer_requires_non_active_source_and_rebuilds_index(tmp_path: Path) -> None:
    with pytest.raises(ChangeSetMemoryError, match="active ChangeSet"):
        create_verified_memory_document(
            tmp_path,
            memory_id="MEM-20260624-001",
            kind="decision",
            source_path="docs/changes/active/CHG-001.md",
            change_set_id="CHG-001",
            work_item_id="UC-001",
            repository_revision="abc123",
            tags=("safety",),
            body="Do not store active ChangeSet text.",
        )

    target = create_verified_memory_document(
        tmp_path,
        memory_id="MEM-20260624-002",
        kind="decision",
        source_path="docs/changes/completed/CHG-001.md",
        change_set_id="CHG-001",
        work_item_id="UC-001",
        repository_revision="abc123",
        tags=("safety", "decision"),
        applies_to=("plan",),
        body="Use completed ChangeSet evidence only.",
    )

    assert target == tmp_path / "docs/memory/decisions/MEM-20260624-002.md"
    assert (tmp_path / ".harness/memory-index/memory-index.json").is_file()
    assert "status: verified" in target.read_text(encoding="utf-8")


def test_writer_rejects_duplicate_memory_id(tmp_path: Path) -> None:
    kwargs = dict(
        memory_id="MEM-20260624-003",
        kind="decision",
        source_path="docs/changes/completed/CHG-001.md",
        change_set_id="CHG-001",
        work_item_id="UC-001",
        repository_revision="abc123",
        tags=("decision",),
        body="Persist one reviewed decision.",
    )
    create_verified_memory_document(tmp_path, **kwargs)

    with pytest.raises(ChangeSetMemoryError, match="already exists"):
        create_verified_memory_document(tmp_path, **kwargs)
