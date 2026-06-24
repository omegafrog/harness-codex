from __future__ import annotations

from pathlib import Path


def test_bundled_completions_include_public_memory_and_exclude_retired_commands() -> None:
    bash = Path("completions/harness.bash").read_text(encoding="utf-8")
    zsh = Path("completions/_harness").read_text(encoding="utf-8")

    assert "memory" in bash
    assert "memory:List, search, or reindex reviewed ChangeSet-first memory" in zsh
    assert "ultrawork" not in bash
    assert "ultrawork" not in zsh
