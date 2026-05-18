from pathlib import Path

import pytest

from harness_codex.runtime.harvest_ui import (
    REQUIREMENTS_PATH,
    USE_CASES_PATH,
    answer_requirements,
    load_harvest_ui,
    start_requirements,
    start_use_cases,
)


def fake_grill_me(_root: Path, session: dict) -> dict:
    index = len(session["clarifications"])
    if index >= 1:
        return {"complete": True, "questions": []}
    return {
        "complete": False,
        "questions": [
            {
                "question": f"Question {index + 1}.{question_index + 1}?",
                "recommended": f"Answer {index + 1}.{question_index + 1}",
            }
            for question_index in range(3)
        ],
    }


def test_harvest_ui_runs_requirements_then_use_cases(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)

    result = start_requirements(tmp_path, "build a queue system")

    assert result.active_stage == "requirements"
    assert result.requirements_gate_passed is False
    assert result.current_question is not None
    assert len(result.current_questions) == 3
    assert (tmp_path / REQUIREMENTS_PATH).is_file()
    assert not (tmp_path / USE_CASES_PATH).exists()

    result = answer_requirements(
        tmp_path,
        "1. member\n2. enter success and denied failure\n3. python fastapi",
    )

    assert result.requirements_gate_passed is True
    assert result.use_cases_ready is False
    assert result.current_question is None

    result = start_use_cases(tmp_path)

    assert result.active_stage == "useCases"
    assert result.use_cases_ready is True
    assert "Runtime step: harvest-use-cases" in result.use_cases_markdown
    assert (tmp_path / USE_CASES_PATH).is_file()


def test_harvest_ui_blocks_use_cases_until_requirements_pass(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_grill_me",
        lambda _root, _session: {
            "complete": False,
            "questions": [{"question": "Next?", "recommended": "Next answer"}],
        },
    )
    start_requirements(tmp_path, "build a queue system")

    with pytest.raises(ValueError, match="requirements gate must pass"):
        start_use_cases(tmp_path)


def test_harvest_ui_blocks_when_grill_me_skill_is_missing(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="missing required Grill-Me skill"):
        start_requirements(tmp_path, "build a queue system")


def test_harvest_ui_recovers_session_from_requirements_doc(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / REQUIREMENTS_PATH).parent.mkdir(parents=True)
    (tmp_path / REQUIREMENTS_PATH).write_text(
        """# Requirements Specification

## 1. Overview
- Initial idea: calculator
- Current gate: In progress

## 5. Grill-Me Loop
| ID | Question | Answer |
|---|---|---|
| GM-1 | Who uses it? | me |
""",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_grill_me",
        lambda _root, _session: {
            "complete": False,
            "questions": [{"question": "Next?", "recommended": "Next answer"}],
        },
    )

    result = load_harvest_ui(tmp_path)

    assert result.initial_prompt == "calculator"
    assert result.clarifications[0]["answer"] == "me"
    assert result.current_questions
    assert (tmp_path / ".harness/ui/harvest-session.json").is_file()
