from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_requirements_question_uses_single_decision_interview() -> None:
    skill = (
        ROOT / ".codex/skills/harness-requirements-question/SKILL.md"
    ).read_text(encoding="utf-8")
    protocol = (
        ROOT
        / ".codex/skills/harness-requirements-question/references/interview-protocol.md"
    ).read_text(encoding="utf-8")

    assert "질문 하나만 제시한다" in skill
    assert "사용자에게 묻지 않는다" in skill
    assert "근거, 구체적 선택지, 추천 답변과 추천 이유" in skill
    assert "결정 트리" in protocol
    assert "같은 ID" in protocol


def test_requirements_document_waits_for_shared_understanding() -> None:
    interviewer = (
        ROOT / ".codex/agents/references/requirements_interviewer.md"
    ).read_text(encoding="utf-8")

    assert "한 번에 한 질문만" in interviewer
    assert "사용자의 동의" in interviewer
    assert "동의 전에는 요구사항 문서를 작성하지 않는다" in interviewer
