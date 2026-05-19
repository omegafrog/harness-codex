from pathlib import Path

import json
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
    if index >= 3:
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


def test_harvest_ui_runs_requirements_then_use_cases_one_question_at_a_time(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)

    result = start_requirements(tmp_path, "build a queue system")

    assert result.active_stage == "requirements"
    assert result.requirements_gate_passed is False
    assert result.current_question is not None
    assert len(result.current_questions) == 1
    assert result.current_question["question"] == "Question 1.1?"
    assert (tmp_path / REQUIREMENTS_PATH).is_file()
    assert (tmp_path / ".harness/ui/harvest-session.json").is_file()
    assert not (tmp_path / USE_CASES_PATH).exists()

    session = json.loads((tmp_path / ".harness/ui/harvest-session.json").read_text(encoding="utf-8"))
    assert len(session["pending_questions"]) == 2

    result = answer_requirements(tmp_path, "answer 1")

    assert result.requirements_gate_passed is False
    assert result.current_question is not None
    assert result.current_question["question"] == "Question 1.2?"
    assert len(result.clarifications) == 1
    assert len(result.clarifications[0]["questions"]) == 1
    assert result.clarifications[0]["questions"][0]["question"] == "Question 1.1?"

    result = answer_requirements(tmp_path, "answer 2")
    assert result.current_question is not None
    assert result.current_question["question"] == "Question 1.3?"

    result = answer_requirements(tmp_path, "answer 3")
    assert result.requirements_gate_passed is True
    assert result.use_cases_ready is False
    assert result.current_question is None

    result = start_use_cases(tmp_path)

    assert result.active_stage == "useCases"
    assert result.use_cases_ready is True
    assert (tmp_path / USE_CASES_PATH).is_file()


def test_harvest_ui_filters_duplicate_grill_me_questions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def duplicate_grill_me(_root: Path, session: dict) -> dict:
        if len(session["clarifications"]) >= 1:
            return {
                "complete": False,
                "questions": [
                    {"question": "Who is the primary actor?", "recommended": "User"},
                    {"question": "What is the success outcome?", "recommended": "Queued"},
                ],
            }
        return {
            "complete": False,
            "questions": [
                {"question": "Who is the primary actor?", "recommended": "User"},
            ],
        }

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", duplicate_grill_me)

    result = start_requirements(tmp_path, "build a queue system")
    assert result.current_question is not None
    assert result.current_question["question"] == "Who is the primary actor?"

    result = answer_requirements(tmp_path, "Customer")

    assert result.current_question is not None
    assert result.current_question["question"] == "What is the success outcome?"


def test_grill_me_prompt_includes_answered_and_pending_questions(
    tmp_path: Path,
) -> None:
    skill_dir = tmp_path / ".codex/skills"
    (skill_dir / "harness-requirements").mkdir(parents=True)
    (skill_dir / "grill-me").mkdir(parents=True)
    (skill_dir / "harness-requirements/SKILL.md").write_text("requirements", encoding="utf-8")
    (skill_dir / "grill-me/SKILL.md").write_text("grill", encoding="utf-8")

    from harness_codex.runtime.harvest_ui import _grill_me_prompt

    prompt = _grill_me_prompt(
        tmp_path,
        {
            "initial_prompt": "queue system",
            "clarifications": [
                {
                    "questions": [{"question": "Who uses it?", "recommended": "Customer"}],
                    "answer": "Customer",
                }
            ],
            "current_question": None,
            "current_questions": [],
            "pending_questions": [{"question": "What is success?", "recommended": "Entry"}],
        },
        skill_dir / "grill-me/SKILL.md",
    )

    assert "Answered question history" in prompt
    assert "Pending question queue" in prompt
    assert "Do not ask semantically equivalent questions" in prompt
    assert "Who uses it?" in prompt
    assert "What is success?" in prompt


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

    with pytest.raises(ValueError, match="requirements gate has not passed"):
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
    assert len(result.current_questions) == 1
    assert (tmp_path / ".harness/ui/harvest-session.json").is_file()
