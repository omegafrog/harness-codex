from pathlib import Path


def test_skill_quality_exposes_the_four_required_checks() -> None:
    text = (Path(__file__).parents[1] / ".codex/skills/harness-skill-quality/SKILL.md").read_text(encoding="utf-8")

    for heading in ("Trigger:", "Structure:", "Guidance:", "Prune:"):
        assert heading in text
    assert len(text.encode("utf-8")) < 1_000
