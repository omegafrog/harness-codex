from pathlib import Path

import json
import pytest

from harness_codex.runtime.harvest_ui import (
    CONTEXT_PATH,
    REQUIREMENTS_PATH,
    USE_CASES_PATH,
    answer_use_cases,
    answer_requirements,
    load_harvest_ui,
    start_requirements,
    start_use_case_generation,
    start_use_cases,
)


def fake_grill_me(_root: Path, session: dict) -> dict:
    index = len(session["clarifications"])
    requirements_markdown = "\n".join(
        [
            "# Requirements Specification",
            "",
            "## 1. Overview",
            f"- Initial idea: {session['initial_prompt']}",
            "",
            "## Grill-Me Clarifications",
            "",
            "| ID | Question | Response |",
            "| --- | --- | --- |",
        ]
        + [
            f"| GM-{item_index:03d} | {(item.get('questions') or [{}])[0].get('question', '')} | {item.get('answer', '')} |"
            for item_index, item in enumerate(session["clarifications"], start=1)
        ]
    )
    context_markdown = "\n".join(
        [
            "# Project Context",
            "",
            "## 1. Ubiquitous Language",
            "",
            "| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |",
            "|---|---|---|---|---|---|---|---|",
            "| User | 사용자 | User | Actor | Primary actor. | - | - | grill-me |",
            "",
            "## 2. Naming Rules",
            "",
            "- Documents must use `Canonical Term`.",
            "- Code class, method, package, command, event, and policy identifiers must use `English`.",
            "- User-facing text should use `Korean`.",
            "- `Forbidden Terms` must not be used in new documents, plans, tests, or code identifiers.",
            "- Aliases are recorded only for migration/search context and must not be introduced as new canonical language.",
            "",
            "## 3. Open Language Questions",
            "",
            "- None.",
        ]
    )
    if index >= 3:
        return {
            "complete": True,
            "questions": [],
            "requirements_markdown": requirements_markdown,
            "context_markdown": context_markdown,
        }
    return {
        "complete": False,
        "questions": [
            {
                "question": f"Question {index + 1}?",
                "recommended": f"Answer {index + 1}",
            }
        ],
        "requirements_markdown": requirements_markdown,
        "context_markdown": context_markdown,
    }


def write_runtime_ready_use_cases(root: Path) -> None:
    (root / USE_CASES_PATH).parent.mkdir(parents=True, exist_ok=True)
    (root / USE_CASES_PATH).write_text(
        "# Use Case Document\n\n## 2. High-Level Use Case List\n- UC-001. User performs goal\n",
        encoding="utf-8",
    )
    use_case_dir = root / "docs/use-cases/UC-001"
    use_case_dir.mkdir(parents=True, exist_ok=True)
    (use_case_dir / "use-case.md").write_text(
        "# UC-001. User performs goal\n\n## Goal\n- Perform goal.\n",
        encoding="utf-8",
    )
    (use_case_dir / "e2e-goal.md").write_text(
        "# UC-001 E2E Goal\n\n## Given\n- Ready.\n\n## When\n- User acts.\n\n## Then\n- Goal succeeds.\n",
        encoding="utf-8",
    )


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
    assert result.current_question["question"] == "Question 1?"
    assert (tmp_path / REQUIREMENTS_PATH).is_file()
    assert (tmp_path / CONTEXT_PATH).is_file()
    assert (tmp_path / ".harness/ui/harvest-session.json").is_file()
    assert not (tmp_path / USE_CASES_PATH).exists()

    session = json.loads((tmp_path / ".harness/ui/harvest-session.json").read_text(encoding="utf-8"))
    assert session["pending_questions"] == []

    result = answer_requirements(tmp_path, "answer 1")

    assert result.requirements_gate_passed is False
    assert result.current_question is not None
    assert result.current_question["question"] == "Question 2?"
    assert len(result.clarifications) == 1
    assert len(result.clarifications[0]["questions"]) == 1
    assert result.clarifications[0]["questions"][0]["question"] == "Question 1?"

    result = answer_requirements(tmp_path, "answer 2")
    assert result.current_question is not None
    assert result.current_question["question"] == "Question 3?"

    result = answer_requirements(tmp_path, "answer 3")
    assert result.requirements_gate_passed is True
    assert result.use_cases_ready is False
    assert result.current_question is None
    assert "Question | Response" in (tmp_path / REQUIREMENTS_PATH).read_text(encoding="utf-8")

    write_runtime_ready_use_cases(tmp_path)
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
                "requirements_markdown": "# Requirements Specification\n",
                "context_markdown": "# Project Context\n\n## 1. Ubiquitous Language\n\n| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |\n|---|---|---|---|---|---|---|---|\n| User | 사용자 | User | Actor | Primary actor. | - | - | grill-me |\n\n## 2. Naming Rules\n\n- Documents must use `Canonical Term`.\n\n## 3. Open Language Questions\n\n- None.\n",
            }
        return {
            "complete": False,
            "questions": [
                {"question": "Who is the primary actor?", "recommended": "User"},
            ],
            "requirements_markdown": "# Requirements Specification\n",
            "context_markdown": "# Project Context\n\n## 1. Ubiquitous Language\n\n| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |\n|---|---|---|---|---|---|---|---|\n| User | 사용자 | User | Actor | Primary actor. | - | - | grill-me |\n\n## 2. Naming Rules\n\n- Documents must use `Canonical Term`.\n\n## 3. Open Language Questions\n\n- None.\n",
        }

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", duplicate_grill_me)

    result = start_requirements(tmp_path, "build a queue system")
    assert result.current_question is not None
    assert result.current_question["question"] == "Who is the primary actor?"

    result = answer_requirements(tmp_path, "Customer")

    assert result.current_question is not None
    assert result.current_question["question"] == "What is the success outcome?"


def test_harvest_ui_keeps_grill_me_running_until_context_has_no_open_language_questions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def incomplete_context_grill_me(_root: Path, session: dict) -> dict:
        if len(session["clarifications"]) >= 1:
            return {
                "complete": True,
                "questions": [],
                "requirements_markdown": "# Requirements Specification\n",
                "context_markdown": "# Project Context\n\n## 1. Ubiquitous Language\n\n| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |\n|---|---|---|---|---|---|---|---|\n| User | 사용자 | User | Actor | Primary actor. | - | - | grill-me |\n| Operator | 연산자 | Operator | Domain Concept | Arithmetic selector. | Selected Operation | - | grill-me |\n\n## 2. Naming Rules\n\n- Documents must use `Canonical Term`.\n\n## 3. Open Language Questions\n\n- None.\n",
            }
        return {
            "complete": True,
            "questions": [],
            "requirements_markdown": "# Requirements Specification\n",
            "context_markdown": "# Project Context\n\n## 1. Ubiquitous Language\n\n| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |\n|---|---|---|---|---|---|---|---|\n| User | 사용자 | User | Actor | Primary actor. | - | - | grill-me |\n\n## 2. Naming Rules\n\n- Documents must use `Canonical Term`.\n\n## 3. Open Language Questions\n\n- Confirm the canonical term for the arithmetic selector.\n",
        }

    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_grill_me",
        incomplete_context_grill_me,
    )

    result = start_requirements(tmp_path, "build a calculator")

    assert result.requirements_gate_passed is False
    assert result.current_question is not None
    assert result.current_question["question"] == "Confirm the canonical term for the arithmetic selector."

    result = answer_requirements(tmp_path, "Use Operator.")

    assert result.requirements_gate_passed is True
    assert result.current_question is None


def test_harvest_ui_uses_open_language_questions_when_grill_me_returns_no_follow_up(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_grill_me",
        lambda _root, _session: {
            "complete": False,
            "questions": [],
            "requirements_markdown": "# Requirements Specification\n",
            "context_markdown": "# Project Context\n\n## 1. Ubiquitous Language\n\n| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |\n|---|---|---|---|---|---|---|---|\n| User | 사용자 | User | Actor | Primary actor. | - | - | grill-me |\n\n## 2. Naming Rules\n\n- Documents must use `Canonical Term`.\n\n## 3. Open Language Questions\n\n- Confirm the canonical term for the arithmetic selector.\n",
        },
    )

    result = start_requirements(tmp_path, "build a calculator")

    assert result.requirements_gate_passed is False
    assert result.current_question is not None
    assert result.current_question["question"] == "Confirm the canonical term for the arithmetic selector."
    assert "Confirm the canonical term" in result.current_question["recommended"]


def test_grill_me_prompt_uses_compact_history_without_skill_bodies_or_drafts() -> None:
    from harness_codex.runtime.harvest_ui import _grill_me_prompt

    prompt = _grill_me_prompt(
        {
            "initial_prompt": "queue system",
            "clarifications": [
                {
                    "questions": [{"question": "Who uses it?", "recommended": "Customer"}],
                    "answer": "Customer",
                }
            ],
            "current_question": {"question": "What is success?", "recommended": "Entry"},
            "current_questions": [{"question": "What is success?", "recommended": "Entry"}],
            "pending_questions": [],
        }
    )

    assert "Compact Q/A history" in prompt
    assert "Do not ask any question already present in Compact Q/A history." in prompt
    assert "Answered question history" not in prompt
    assert "Clarification history" not in prompt
    assert "Active question" not in prompt
    assert "Do not ask semantically equivalent questions" in prompt
    assert "Return only JSON with keys: complete, questions." in prompt
    assert "requirements_markdown" not in prompt
    assert "context_markdown" not in prompt
    assert "Harness requirements standards" not in prompt
    assert "Grill-Me skill" not in prompt
    assert "Who uses it?" in prompt
    assert "What is success?" in prompt
    assert '"status": "answered"' in prompt
    assert '"status": "active"' in prompt


def test_grill_me_finalization_prompt_uses_compact_history_and_writer_contract() -> None:
    from harness_codex.runtime.harvest_ui import _grill_me_finalization_prompt

    prompt = _grill_me_finalization_prompt(
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
            "pending_questions": [],
        },
        "requirements skill body",
    )

    assert "Compact Q/A history" in prompt
    assert "requirements_markdown" in prompt
    assert "context_markdown" in prompt
    assert "Harness requirements standards" in prompt
    assert "requirements skill body" in prompt
    assert "Return complete=true only when context_markdown has no unresolved entries" in prompt


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


def test_harvest_ui_runs_use_case_generation_one_question_at_a_time(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
    result = start_requirements(tmp_path, "build a queue system")
    result = answer_requirements(tmp_path, "answer 1")
    result = answer_requirements(tmp_path, "answer 2")
    result = answer_requirements(tmp_path, "answer 3")
    assert result.requirements_gate_passed is True

    calls = []

    def fake_use_case_harvest(root: Path, session: dict, _idea: str) -> dict:
        calls.append(len(session["use_case_clarifications"]))
        if len(session["use_case_clarifications"]) >= 1:
            write_runtime_ready_use_cases(root)
            return {
                "status": "complete",
                "questions": [],
                "changed_files": [
                    "docs/design/유스케이스.md",
                    "docs/use-cases/UC-001/use-case.md",
                    "docs/use-cases/UC-001/e2e-goal.md",
                ],
                "blocker": "",
            }
        return {
            "status": "needs_input",
            "questions": [
                {
                    "question": "Should Clear reset the result?",
                    "recommended": "Yes.",
                }
            ],
            "changed_files": [],
            "blocker": "",
        }

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_use_case_harvest", fake_use_case_harvest)

    result = start_use_case_generation(tmp_path, "build a queue system")

    assert result.active_stage == "useCases"
    assert result.use_cases_ready is False
    assert result.current_question is not None
    assert result.current_question["question"] == "Should Clear reset the result?"

    result = answer_use_cases(tmp_path, "Yes, reset it.", "build a queue system")

    assert calls == [0, 1]
    assert result.use_cases_ready is True
    assert result.current_question is None
    assert (tmp_path / USE_CASES_PATH).is_file()


def test_harvest_ui_blocks_when_use_case_generation_reports_complete_without_docs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
    start_requirements(tmp_path, "build a queue system")
    answer_requirements(tmp_path, "answer 1")
    answer_requirements(tmp_path, "answer 2")
    answer_requirements(tmp_path, "answer 3")
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_use_case_harvest",
        lambda _root, _session, _idea: {
            "status": "complete",
            "questions": [],
            "changed_files": [],
            "blocker": "",
        },
    )

    with pytest.raises(ValueError, match="runtime-ready use-case docs are missing"):
        start_use_case_generation(tmp_path, "build a queue system")


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
| ID | Question | Response |
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
