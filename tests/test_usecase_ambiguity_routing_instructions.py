from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_text(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def test_usecase_ambiguity_is_routed_before_questions() -> None:
    contracts = (
        read_text(".codex/skills/harness-usecases/references/standards.md"),
        read_text(".codex/skills/harness-usecases/references/invocation.md"),
        read_text(".codex/agents/references/harness_usecases.md"),
    )

    for contract in contracts:
        assert "Before asking a Grill-Me question, classify the ambiguity." in contract
        assert "canonical noun, role label, state label, alias, or meaning boundary" in contract
        assert "$harness-ubiquitous-language" in contract
        assert "$harness-requirements" in contract
        assert "Do not promote a role of an existing actor to a new actor" in contract
        assert "single-goal decomposition ambiguity" in contract


def test_usecase_contract_has_blocked_and_input_routes() -> None:
    agent_contract = read_text(".codex/agents/references/harness_usecases.md")

    assert "return `blocked`" in agent_contract
    assert "return `needs_input`" in agent_contract


def test_ubiquitous_language_keeps_actions_and_state_labels_distinct() -> None:
    contracts = (
        read_text(".codex/skills/harness-ubiquitous-language/references/detailed-instructions.md"),
        read_text(".codex/agents/references/ubiquitous_language_reviewer.md"),
    )

    for contract in contracts:
        assert "Canonical vocabulary covers domain concepts, stable roles, user-visible concepts, and state labels" in contract
        assert "Do not require every use-case verb" in contract
        assert "A use-case goal may combine a verb with canonical domain concepts." in contract
