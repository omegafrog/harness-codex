from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.prompt import (
    PROMPT_CONTEXT_PREVIEW_CHARS,
    _cached_context_block,
)


def test_cached_context_prompt_preview_is_bounded(tmp_path: Path) -> None:
    content = "x" * (PROMPT_CONTEXT_PREVIEW_CHARS + 500)

    block = _cached_context_block(
        Path("AGENTS.md"),
        content,
        "text",
        repo_root=tmp_path,
    )

    assert f"{content[:PROMPT_CONTEXT_PREVIEW_CHARS]}\n..." in block
    assert content[PROMPT_CONTEXT_PREVIEW_CHARS:] not in block
