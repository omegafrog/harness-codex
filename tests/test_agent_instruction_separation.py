from __future__ import annotations

from pathlib import Path


def test_every_agent_profile_is_role_only_and_short() -> None:
    root = Path(__file__).parents[1]
    for path in (root / ".codex/agents").glob("*.toml"):
        text = path.read_text(encoding="utf-8")
        assert "Responsibility:" in text, path
        assert "Forbidden:" in text, path
        assert "Result:" in text, path
        assert len(text.encode("utf-8")) <= 1_200, path


def test_skills_hold_sequence_not_agent_profile_sections() -> None:
    root = Path(__file__).parents[1]
    for path in (root / ".codex/skills").glob("*/SKILL.md"):
        text = path.read_text(encoding="utf-8")
        if path.parent.name.startswith("harness-"):
            assert "Responsibility:" not in text, path
            assert "Forbidden:" not in text, path
