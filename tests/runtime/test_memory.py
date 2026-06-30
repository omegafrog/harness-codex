from pathlib import Path

import pytest

from harness_codex.canonical_cli import main as public_main
from harness_codex.runtime.memory import MemoryError, score_memory_candidate


def _write_verified_memory(root: Path) -> None:
    path = root / "docs/memory/decisions/MEM-20260624-001.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            [
                "---",
                "memory_id: MEM-20260624-001",
                "kind: decision",
                "source_path: docs/changes/completed/CHG-001.md",
                "change_set_id: CHG-001",
                "work_item_id: UC-001",
                "status: verified",
                "repository_revision: abc123",
                "tags:",
                "  - workflow-materialization",
                "applies_to:",
                "  - plan",
                "created_at: '2026-06-24'",
                "---",
                "",
                "Use verified completion evidence for workflow materialization decisions.",
            ]
        ),
        encoding="utf-8",
    )


def test_public_memory_command_lists_change_set_first_documents(tmp_path: Path, capsys) -> None:
    _write_verified_memory(tmp_path)

    exit_code = public_main(["--repo-root", str(tmp_path), "memory", "list"])

    assert exit_code == 0
    output = capsys.readouterr().out
    assert "MEM-20260624-001" in output
    assert "docs/memory/decisions/MEM-20260624-001.md" in output
    assert ".harness/memory/" not in output


def test_public_memory_command_searches_and_reindexes(tmp_path: Path, capsys) -> None:
    _write_verified_memory(tmp_path)

    assert public_main(["--repo-root", str(tmp_path), "memory", "reindex"]) == 0
    assert ".harness/memory-index/memory-index.json" in capsys.readouterr().out

    assert public_main(
        [
            "--repo-root",
            str(tmp_path),
            "memory",
            "search",
            "workflow-materialization",
            "--stage",
            "plan",
        ]
    ) == 0
    output = capsys.readouterr().out
    assert "reference_only=true" in output
    assert "source=docs/changes/completed/CHG-001.md" in output


def test_public_memory_cache_reads_and_reports_stats(tmp_path: Path, capsys) -> None:
    source = tmp_path / "src/app.py"
    source.parent.mkdir()
    source.write_text("print('cached')\n", encoding="utf-8")

    assert public_main(["--repo-root", str(tmp_path), "memory", "cache", "read", "src/app.py"]) == 0
    assert "print('cached')" in capsys.readouterr().out

    assert public_main(
        [
            "--repo-root",
            str(tmp_path),
            "memory",
            "cache",
            "read",
            "src/app.py",
            "--metadata",
        ]
    ) == 0
    metadata = capsys.readouterr().out
    assert "path=src/app.py" in metadata
    assert "cache_hit=true" in metadata

    assert public_main(["--repo-root", str(tmp_path), "memory", "cache", "stats"]) == 0
    stats = capsys.readouterr().out
    assert "indexed_files=1" in stats


def test_legacy_score_promotion_is_retired() -> None:
    with pytest.raises(MemoryError, match="score promotion is removed"):
        score_memory_candidate({"status": "active"})
