from pathlib import Path

import pytest

from harness_codex.runtime.file_memory_cache import (
    FileMemoryCacheError,
    clear_file_cache,
    file_cache_stats,
    read_file_cache,
    warm_file_cache,
)


def test_file_cache_reads_hits_and_refreshes_when_file_changes(tmp_path: Path) -> None:
    source = tmp_path / "src/app.py"
    source.parent.mkdir()
    source.write_text("print('first')\n", encoding="utf-8")

    first = read_file_cache(tmp_path, "src/app.py")
    second = read_file_cache(tmp_path, "src/app.py")
    source.write_text("print('second')\n", encoding="utf-8")
    third = read_file_cache(tmp_path, "src/app.py")

    assert first.cache_hit is False
    assert second.cache_hit is True
    assert second.content == "print('first')\n"
    assert third.cache_hit is False
    assert third.content == "print('second')\n"
    assert file_cache_stats(tmp_path)["indexed_files"] == 1


def test_file_cache_warm_skips_unsafe_and_binary_paths(tmp_path: Path) -> None:
    text = tmp_path / "src/app.py"
    binary = tmp_path / "src/blob.bin"
    text.parent.mkdir()
    text.write_text("ok\n", encoding="utf-8")
    binary.write_bytes(b"\xff")

    result = warm_file_cache(tmp_path, ["src/app.py", "../outside.py", "src/blob.bin"])

    assert result.warmed == 1
    assert result.refreshed == 1
    assert len(result.skipped) == 2
    assert any("outside repo" in item or "inside repo" in item for item in result.skipped)
    assert any("utf-8 text" in item for item in result.skipped)


def test_file_cache_clear_removes_snapshots(tmp_path: Path) -> None:
    source = tmp_path / "src/app.py"
    source.parent.mkdir()
    source.write_text("ok\n", encoding="utf-8")
    read_file_cache(tmp_path, "src/app.py")

    removed = clear_file_cache(tmp_path)

    assert removed >= 1
    assert file_cache_stats(tmp_path) == {
        "indexed_files": 0,
        "cache_files": 0,
        "cache_bytes": 0,
    }


def test_file_cache_rejects_large_files(tmp_path: Path) -> None:
    source = tmp_path / "large.txt"
    source.write_text("12345", encoding="utf-8")

    with pytest.raises(FileMemoryCacheError, match="exceeds max bytes"):
        read_file_cache(tmp_path, "large.txt", max_bytes=4)
