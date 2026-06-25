from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
SKILL_INSTRUCTIONS = REPO_ROOT / ".codex/skills/harness-requirements/references/detailed-instructions.md"
WORKER_PROMPT = REPO_ROOT / ".codex/skills/harness-requirements/references/agent-prompt.md"
INTERVIEWER_INSTRUCTIONS = REPO_ROOT / ".codex/agents/references/requirements_interviewer.md"


def test_requirements_skill_uses_four_use_case_limit() -> None:
    text = SKILL_INSTRUCTIONS.read_text(encoding="utf-8")

    assert "one coherent ChangeSet delivery scope" in text
    assert "one through four included use cases" in text
    assert "five or more use cases" in text
    assert "- Included use cases (1-4):" in text


def test_requirements_worker_prompt_uses_four_use_case_limit() -> None:
    text = WORKER_PROMPT.read_text(encoding="utf-8")

    assert "one through four closely related use cases" in text
    assert "five or more use cases" in text
    assert "reduce it before reporting readiness" in text


def test_requirements_interviewer_uses_four_use_case_limit() -> None:
    text = INTERVIEWER_INSTRUCTIONS.read_text(encoding="utf-8")

    assert "delivery-sized ChangeSet containing one through four use cases" in text
    assert "five or more use cases" in text
    assert "reduce it before completing requirements" in text
