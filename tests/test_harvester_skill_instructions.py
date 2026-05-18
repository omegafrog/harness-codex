from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_harvester_skills_ask_one_question_with_recommendation() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md",
        REPO_ROOT / ".codex/agents/harness_requirements.toml",
        REPO_ROOT / ".codex/skills/harness-requirements/references/agent-prompt.md",
        REPO_ROOT / ".codex/skills/harness-usecases/SKILL.md",
        REPO_ROOT / ".codex/agents/harness_usecases.toml",
        REPO_ROOT / ".codex/skills/harness-usecases/references/agent-prompt.md",
    )

    for path in paths:
        text = path.read_text(encoding="utf-8")
        assert "one focused question at a time" in text
        assert "Recommended answer" in text
        assert "3-7" not in text


def test_requirements_skill_explores_local_context_before_questions() -> None:
    skill = (REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md").read_text(
        encoding="utf-8"
    )
    agent = (REPO_ROOT / ".codex/agents/harness_requirements.toml").read_text(
        encoding="utf-8"
    )

    assert "inspect them first" in skill
    assert "Before asking the user a question" in agent


def test_requirements_harvest_owns_context_language() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md",
        REPO_ROOT / ".codex/agents/harness_requirements.toml",
        REPO_ROOT / ".codex/skills/harness-requirements/references/agent-prompt.md",
    )

    for path in paths:
        text = path.read_text(encoding="utf-8")
        assert "context.md" in text
        assert "Ubiquitous Language" in text or "ubiquitous language" in text
        assert "Forbidden Terms" in text
        assert "Open Language Questions" in text


def test_usecases_consume_context_language_without_editing_it() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-usecases/SKILL.md",
        REPO_ROOT / ".codex/agents/harness_usecases.toml",
        REPO_ROOT / ".codex/skills/harness-usecases/references/agent-prompt.md",
    )

    for path in paths:
        text = path.read_text(encoding="utf-8")
        assert "context.md" in text
        assert "canonical terms" in text or "canonical" in text
        assert "Forbidden Terms" in text
        assert "Do not edit context.md" in text or "or context.md" in text
