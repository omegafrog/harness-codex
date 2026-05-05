from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_harvester_skill_asks_one_question_with_recommendation() -> None:
    skill = (
        REPO_ROOT / ".codex/skills/harness-requirements-usecases/SKILL.md"
    ).read_text(encoding="utf-8")
    agent = (REPO_ROOT / ".codex/agents/harness_requirements_usecases.toml").read_text(
        encoding="utf-8"
    )
    prompt = (
        REPO_ROOT
        / ".codex/skills/harness-requirements-usecases/references/agent-prompt.md"
    ).read_text(encoding="utf-8")

    for text in (skill, agent, prompt):
        assert "질문은 한 번에 하나" in text or "one focused question at a time" in text
        assert "권장 답변" in text
        assert "3-7" not in text


def test_harvester_skill_explores_local_context_before_questions() -> None:
    skill = (
        REPO_ROOT / ".codex/skills/harness-requirements-usecases/SKILL.md"
    ).read_text(encoding="utf-8")
    agent = (REPO_ROOT / ".codex/agents/harness_requirements_usecases.toml").read_text(
        encoding="utf-8"
    )

    assert "사용자에게 묻기 전에 먼저 탐색" in skill
    assert "Before asking the user a question" in agent
