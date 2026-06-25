from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_contract(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    if path.name == "SKILL.md":
        detailed = path.parent / "references/detailed-instructions.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
        if path.parent.name == "harness-usecases":
            for reference_name in ("agent-prompt.md", "invocation.md", "runtime-contract.md", "templates.md"):
                reference = path.parent / "references" / reference_name
                if reference.exists():
                    text += "\n" + reference.read_text(encoding="utf-8")
    if path.suffix == ".toml":
        detailed = path.parent / "references" / f"{path.stem}.md"
        if detailed.exists():
            text += "\n" + detailed.read_text(encoding="utf-8")
    return text


def test_harvester_skills_ask_up_to_three_questions_with_recommendations() -> None:
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
        assert "up to three" in text or "up to 3" in text
        assert "Recommended answer" in text
        assert "3-7" not in text

        assert "requirements stage can be correct" in text

    for path in language_paths:
        text = read_contract(path)
        assert "up to three" in text or "up to 3" in text
        assert "Recommended answer" in text
        assert "language blockers" in text

    for path in usecase_paths:
        text = read_contract(path)
        assert "up to three" in text or "up to 3" in text


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
        assert (
            "Do not write `docs/design/ubiquitous-language.md`" in text
            or "Do not own full ubiquitous language confirmation" in text
        )
        assert "Language Handoff Notes" in text


def test_ubiquitous_language_skill_owns_context_language() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-ubiquitous-language/SKILL.md",
        REPO_ROOT / ".codex/agents/ubiquitous_language_reviewer.toml",
        REPO_ROOT / ".codex/skills/harness-ubiquitous-language/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "docs/design/ubiquitous-language.md" in text
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


def test_main_flow_grill_me_stages_are_draft_first_and_boundary_scoped() -> None:
    stage_contracts = {
        "requirements": read_contract(
            REPO_ROOT / ".codex/skills/harness-requirements/SKILL.md"
        ),
        "language": read_contract(
            REPO_ROOT / ".codex/skills/harness-ubiquitous-language/SKILL.md"
        ),
        "usecases": read_contract(
            REPO_ROOT / ".codex/skills/harness-usecases/SKILL.md"
        ),
        "eventstorming": read_contract(
            REPO_ROOT / ".codex/skills/harness-event-storming/SKILL.md"
        ),
    }
    ddd_contract = read_contract(REPO_ROOT / ".codex/agents/references/ddd_architect.md")

    for text in stage_contracts.values():
        assert "before asking questions" in text
        assert "up to three" in text or "up to 3" in text
        assert "status" in text
        assert "questions" in text
        assert "changed_files" in text
        assert "blocker" in text

    assert "canonical naming" in stage_contracts["requirements"]
    assert "broad requirements" in stage_contracts["language"]
    assert "harness-ubiquitous-language" in stage_contracts["usecases"]
    assert "docs/design/ubiquitous-language.md" in stage_contracts["usecases"]
    assert "Do not ask aggregate, DDD architecture, or technical strategy questions" in stage_contracts["eventstorming"]
    assert "Do not ask the user to choose representation details already implied" in ddd_contract
    assert "When slice evidence fully implies one model shape" in ddd_contract


def test_usecases_consume_context_language_without_editing_it() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-usecases/SKILL.md",
        REPO_ROOT / ".codex/agents/harness_usecases.toml",
        REPO_ROOT / ".codex/skills/harness-usecases/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "docs/design/ubiquitous-language.md" in text
        assert "canonical terms" in text or "canonical" in text
        assert "Forbidden Terms" in text
        assert "Do not edit docs/design/ubiquitous-language.md" in text or "or docs/design/ubiquitous-language.md" in text


def test_usecases_route_missing_context_to_ubiquitous_language() -> None:
    paths = (
        REPO_ROOT / ".codex/skills/harness-usecases/SKILL.md",
        REPO_ROOT / ".codex/agents/harness_usecases.toml",
        REPO_ROOT / ".codex/skills/harness-usecases/references/agent-prompt.md",
    )

    for path in paths:
        text = read_contract(path)
        assert "$harness-ubiquitous-language" in text
        assert "docs/design/ubiquitous-language.md" in text
        if "run $harness-requirements first" in text:
            assert "If docs/design/요구사항.md is missing" in text


def test_usecase_nfr_template_is_limited_to_observable_requirement_constraints() -> None:
    text = read_contract(REPO_ROOT / ".codex/skills/harness-usecases/SKILL.md")
    agent = read_contract(REPO_ROOT / ".codex/agents/harness_usecases.toml")

    assert "Observable Constraints From Requirements" in text
    assert "Confirmed Requirement Constraints Referenced By Use Cases" in text
    assert "do not invent scalability, concurrency, audit, security, availability" in text
    assert "System-Wide Non-Functional Requirements" not in text
    assert "Concurrency Control" not in text
    assert "Observable Constraints From Requirements" in agent


def test_technical_decisions_reference_excludes_business_api_behavior_policy() -> None:
    text = read_contract(REPO_ROOT / ".codex/agents/technical_decisions.toml")

    assert "framework/library choice" in text
    assert "cipher/crypto primitive" in text
    assert "API behavior that changes the approved use-case contract" in text
    assert "user-visible behavior" in text
    assert "success/failure policy" in text
    assert "retention, cleanup, source metadata" in text
    assert "backend save failure to user-visible response" not in text


def test_ddd_design_defers_technical_stack_choices() -> None:
    agent = read_contract(REPO_ROOT / ".codex/agents/references/ddd_architect.md")
    skill = read_contract(REPO_ROOT / ".codex/skills/harness-ddd-design/SKILL.md")

    assert "Do not block on technical stack choices" in agent
    assert "storage family" in agent
    assert "messaging technology" in agent
    assert "performance target" in agent
    assert "domain shape impossible" in agent
    assert "기술 stack 선택은 DDD 설계를 막지 않는다" in skill
