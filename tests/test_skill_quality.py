from pathlib import Path


def test_skill_quality_exposes_the_four_required_checks() -> None:
    text = (Path(__file__).parents[1] / ".codex/skills/harness-skill-quality/SKILL.md").read_text(encoding="utf-8")

    for heading in ("Trigger:", "Structure:", "Guidance:", "Prune:"):
        assert heading in text
    assert "사용자 호출" in text
    assert "모델 호출" in text
    assert "한 단계 reference" in text
    assert "먼 최종 목표" in text
    assert "지워도 결과가 같으면 삭제" in text
    assert len(text.encode("utf-8")) < 1_000
