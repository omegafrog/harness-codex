from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_INSTRUCTIONS = REPO_ROOT / ".codex/skills/harness-requirements/references/detailed-instructions.md"
INTERVIEWER_INSTRUCTIONS = REPO_ROOT / ".codex/agents/references/requirements_interviewer.md"


def test_requirements_skill_allows_coherent_multi_use_case_scope() -> None:
    text = SKILL_INSTRUCTIONS.read_text(encoding="utf-8")

    assert "one coherent MVP delivery scope" in text
    assert "multiple closely related use cases" in text
    assert "## Scope Selection" in text
    assert "- Included use cases:" in text
    assert "- Supporting / prerequisite work items:" in text


def test_requirements_interviewer_preserves_changeset_boundary() -> None:
    text = INTERVIEWER_INSTRUCTIONS.read_text(encoding="utf-8")

    assert "delivery-sized ChangeSet" in text
    assert "Do not force an arbitrary single use case" in text
    assert "Split independently valuable, independently verifiable, or unrelated use cases" in text
