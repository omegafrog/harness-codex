from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_grill_me_delegates_to_grilling() -> None:
    skill = (ROOT / ".codex/skills/grill-me/SKILL.md").read_text(encoding="utf-8")

    assert "name: grill-me" in skill
    assert "disable-model-invocation: true" in skill
    assert "Run a `/grilling` session." in skill


def test_grilling_preserves_single_question_decision_protocol() -> None:
    skill = (ROOT / ".codex/skills/grilling/SKILL.md").read_text(encoding="utf-8")

    assert "name: grilling" in skill
    assert "Ask the questions one at a time" in skill
    assert "If a *fact* can be found by exploring the environment" in skill
    assert "The *decisions*, though, are mine" in skill
    assert "Do not act on it until I confirm" in skill
