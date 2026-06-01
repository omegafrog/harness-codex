from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_contract(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if path.name == "SKILL.md":
        detailed = path.parent / "references/detailed-instructions.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
    if path.suffix == ".toml":
        detailed = path.parent / "references" / f"{path.stem}.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
    return text


def test_harvester_skills_ask_one_question_with_recommendation() -> None:
    all_paths = (
        REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md",
        REPO_ROOT / ".codex/agents/requirements_interviewer.toml",
        REPO_ROOT / ".codex/skills/harness-requirements/references/agent-prompt.md",
        REPO_ROOT / ".codex/skills/harness-ubiquitous-language/SKILL.md",
        REPO_ROOT / ".codex/agents/ubiquitous_language_reviewer.toml",
        REPO_ROOT / ".codex/skills/harness-ubiquitous-language/references/agent-prompt.md",
        REPO_ROOT / ".codex/skills/harness-usecases/SKILL.md",
        REPO_ROOT / ".codex/agents/harness_usecases.toml",
        REPO_ROOT / ".codex/skills/harness-usecases/references/agent-prompt.md",
    )

    requirement_paths = all_paths[:3]
    language_paths = all_paths[3:6]
    usecase_paths = all_paths[6:]

    for path in requirement_paths:
        text = read_contract(path)
        assert "one focused question at a time" in text
        assert "Recommended answer" in text
        assert "3-7" not in text

        assert "single highest-priority blocker" in text

    for path in language_paths:
        text = read_contract(path)
        assert "one focused question at a time" in text
        assert "Recommended answer" in text
        assert "single highest-priority language blocker" in text

    for path in usecase_paths:
        text = read_contract(path)
        assert "one JSON needs_input question" in text or "one focused question at a time" in text


def test_requirements_grill_me_questioning_is_time_boxed() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md",
        REPO_ROOT / ".codex/agents/requirements_interviewer.toml",
        REPO_ROOT / ".codex/skills/harness-requirements/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "at most 3 rounds" in text
        assert "After each round" in text
        assert "not continue asking until the domain is perfect" in text
        assert "produce a draft" in text
        assert "Language Handoff Notes" in text


def test_requirements_harvest_defers_technology_specific_questions() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md",
        REPO_ROOT / ".codex/agents/requirements_interviewer.toml",
        REPO_ROOT / ".codex/skills/harness-requirements/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "questions by default" in text
        assert "authentication" in text
        assert "authorization" in text
        assert "cache" in text
        assert "messaging" in text


def test_requirements_skill_explores_local_context_before_questions() -> None:
    skill = read_contract(REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md")
    agent = read_contract(REPO_ROOT / ".codex/agents/requirements_interviewer.toml")

    assert "inspect them first" in skill
    assert "Before asking the user a question" in agent


def test_requirements_harvest_does_not_own_full_context_language() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md",
        REPO_ROOT / ".codex/agents/requirements_interviewer.toml",
        REPO_ROOT / ".codex/skills/harness-requirements/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "harness-ubiquitous-language" in text
        assert "Do not write `context.md`" in text or "Do not own full ubiquitous language confirmation" in text
        assert "Language Handoff Notes" in text


def test_ubiquitous_language_skill_owns_context_language() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-ubiquitous-language/SKILL.md",
        REPO_ROOT / ".codex/agents/ubiquitous_language_reviewer.toml",
        REPO_ROOT / ".codex/skills/harness-ubiquitous-language/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "context.md" in text
        assert "canonical term" in text or "canonical" in text
        assert "Forbidden Terms" in text or "forbidden terms" in text
        assert "upstream requirements blocker" in text


def test_requirements_grill_me_does_not_ask_design_naming_questions() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md",
        REPO_ROOT / ".codex/agents/requirements_interviewer.toml",
        REPO_ROOT / ".codex/skills/harness-requirements/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "must not ask" in text or "Do not ask" in text
        assert "aggregate" in text
        assert "domain event" in text
        assert "state-transition" in text


def test_ubiquitous_language_grill_me_does_not_reopen_requirements() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-ubiquitous-language/SKILL.md",
        REPO_ROOT / ".codex/agents/ubiquitous_language_reviewer.toml",
        REPO_ROOT / ".codex/skills/harness-ubiquitous-language/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "Do not reopen requirements" in text or "Do not ask broad requirements questions" in text
        assert "upstream requirements blocker" in text


def test_usecases_consume_context_language_without_editing_it() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-usecases/SKILL.md",
        REPO_ROOT / ".codex/agents/harness_usecases.toml",
        REPO_ROOT / ".codex/skills/harness-usecases/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "context.md" in text
        assert "canonical terms" in text or "canonical" in text
        assert "Forbidden Terms" in text
        assert "Do not edit context.md" in text or "or context.md" in text
