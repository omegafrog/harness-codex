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
