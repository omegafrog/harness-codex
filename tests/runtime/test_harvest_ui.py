from pathlib import Path

import json
import re
import pytest

from harness_codex.runtime.harvest_ui import (
    CONTEXT_PATH,
    REQUIREMENTS_PATH,
    USE_CASES_PATH,
    activate_changeset_harvest_ui,
    answer_use_cases,
    answer_requirements,
    load_changeset_harvest_ui,
    load_harvest_ui,
    save_changeset_harvest_ui,
    start_requirements,
    start_use_case_generation,
    start_use_cases,
)


def write_active_changeset(root: Path, change_set_id: str) -> None:
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"# {change_set_id}\n", encoding="utf-8")


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


def write_passed_requirements(root: Path, initial_idea: str = "calculator") -> None:
    (root / REQUIREMENTS_PATH).parent.mkdir(parents=True, exist_ok=True)
    (root / REQUIREMENTS_PATH).write_text(
        "\n".join(
            [
                "# Requirements Specification",
                "",
                "## 1. Overview",
                f"- Initial idea: {initial_idea}",
                "- Current gate: Passed",
                "",
                "## 5. Grill-Me Loop",
                "| ID | Question | Response |",
                "|---|---|---|",
                "| GM-1 | Who uses it? | me |",
                "",
            ]
        ),
        encoding="utf-8",
    )


def write_canonical_use_cases(root: Path, content: str) -> None:
    (root / USE_CASES_PATH).parent.mkdir(parents=True, exist_ok=True)
    (root / USE_CASES_PATH).write_text(content, encoding="utf-8")


def write_use_case_slice(root: Path, uc_id: str = "UC-001") -> None:
    use_case_dir = root / f"docs/use-cases/{uc_id}"
    use_case_dir.mkdir(parents=True, exist_ok=True)
    (use_case_dir / "use-case.md").write_text(
        f"# {uc_id}. User performs goal\n\n## Goal\n- Perform goal.\n",
        encoding="utf-8",
    )
    (use_case_dir / "e2e-goal.md").write_text(
        f"# {uc_id} E2E Goal\n\n## Given\n- Ready.\n\n## When\n- User acts.\n\n## Then\n- Goal succeeds.\n",
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


def test_changeset_resume_restores_pending_question_without_advancing_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
    start_requirements(tmp_path, "build a queue system")
    write_active_changeset(tmp_path, "CHG-20260526-001")
    save_changeset_harvest_ui(tmp_path, "CHG-20260526-001")
    scoped_session = tmp_path / ".harness/ui/change-sets/CHG-20260526-001/harvest-session.json"
    session_before = scoped_session.read_text(encoding="utf-8")
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_grill_me",
        lambda _root, _session: pytest.fail("resume must not run Grill-Me"),
    )

    result = load_changeset_harvest_ui(tmp_path, "CHG-20260526-001")

    assert result.active_stage == "requirements"
    assert result.current_question is not None
    assert result.current_question["question"] == "Question 1?"
    assert scoped_session.read_text(encoding="utf-8") == session_before


def test_changeset_resume_corrects_stale_stage_from_requirements_gate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
    start_requirements(tmp_path, "build a queue system")
    write_active_changeset(tmp_path, "CHG-20260526-001")
    save_changeset_harvest_ui(tmp_path, "CHG-20260526-001")
    scoped_session = tmp_path / ".harness/ui/change-sets/CHG-20260526-001/harvest-session.json"
    session = json.loads(scoped_session.read_text(encoding="utf-8"))
    session["active_stage"] = "useCases"
    scoped_session.write_text(json.dumps(session), encoding="utf-8")

    result = load_changeset_harvest_ui(tmp_path, "CHG-20260526-001")

    assert result.requirements_gate_passed is False
    assert result.active_stage == "requirements"


def test_changeset_sessions_continue_independently(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
    start_requirements(tmp_path, "first workflow")
    write_active_changeset(tmp_path, "CHG-20260526-001")
    save_changeset_harvest_ui(tmp_path, "CHG-20260526-001")
    start_requirements(tmp_path, "second workflow")
    write_active_changeset(tmp_path, "CHG-20260526-002")
    save_changeset_harvest_ui(tmp_path, "CHG-20260526-002")

    activate_changeset_harvest_ui(tmp_path, "CHG-20260526-001")
    answer_requirements(tmp_path, "first answer")
    save_changeset_harvest_ui(tmp_path, "CHG-20260526-001")

    first = load_changeset_harvest_ui(tmp_path, "CHG-20260526-001")
    second = load_changeset_harvest_ui(tmp_path, "CHG-20260526-002")
    assert first.current_question is not None
    assert first.current_question["question"] == "Question 2?"
    assert second.current_question is not None
    assert second.current_question["question"] == "Question 1?"
    assert second.initial_prompt == "second workflow"


def test_changeset_resume_recovers_single_active_session_from_completed_requirements_doc(tmp_path: Path) -> None:
    write_active_changeset(tmp_path, "CHG-20260526-001")
    (tmp_path / REQUIREMENTS_PATH).parent.mkdir(parents=True)
    (tmp_path / REQUIREMENTS_PATH).write_text(
        """# Requirements Specification

## 1. Overview
- Initial idea: build note explorer

## 8. Business Policy Decisions Needed
- None.

## 9. Foundational Technology Decisions Needed
- None required to define this MVP ChangeSet.
""",
        encoding="utf-8",
    )

    result = load_changeset_harvest_ui(tmp_path, "CHG-20260526-001")

    assert result.requirements_gate_passed is True
    assert result.active_stage == "requirements"
    assert (tmp_path / ".harness/ui/change-sets/CHG-20260526-001/harvest-session.json").exists()


def test_changeset_resume_rejects_missing_scoped_state_when_active_owner_is_ambiguous(tmp_path: Path) -> None:
    write_active_changeset(tmp_path, "CHG-20260526-001")
    write_active_changeset(tmp_path, "CHG-20260526-002")

    with pytest.raises(ValueError, match="Resume unavailable for CHG-20260526-001"):
        load_changeset_harvest_ui(tmp_path, "CHG-20260526-001")


def test_harvest_ui_requires_canonical_use_case_doc_before_ready(tmp_path: Path) -> None:
    write_passed_requirements(tmp_path)

    result = load_harvest_ui(tmp_path)

    assert result.use_cases_ready is False
    with pytest.raises(
        ValueError,
        match=re.escape(
            "docs/design/유스케이스.md is missing, empty, or has no parseable UC entries. Expected '- UC-001. ...' or '## UC-001. ...'."
        ),
    ):
        start_use_cases(tmp_path)


def test_harvest_ui_rejects_empty_canonical_use_case_doc(tmp_path: Path) -> None:
    write_passed_requirements(tmp_path)
    write_canonical_use_cases(tmp_path, " \n")

    with pytest.raises(
        ValueError,
        match=re.escape(
            "docs/design/유스케이스.md is missing, empty, or has no parseable UC entries. Expected '- UC-001. ...' or '## UC-001. ...'."
        ),
    ):
        start_use_cases(tmp_path)


def test_harvest_ui_rejects_unparseable_canonical_use_case_doc(tmp_path: Path) -> None:
    write_passed_requirements(tmp_path)
    write_canonical_use_cases(
        tmp_path,
        "# Use Case Document\n\n## 2. High-Level Use Case List\n- User performs goal\n",
    )

    with pytest.raises(
        ValueError,
        match=re.escape(
            "docs/design/유스케이스.md is missing, empty, or has no parseable UC entries. Expected '- UC-001. ...' or '## UC-001. ...'."
        ),
    ):
        start_use_cases(tmp_path)


def test_harvest_ui_accepts_bullet_canonical_use_case_entries(tmp_path: Path) -> None:
    write_passed_requirements(tmp_path)
    write_canonical_use_cases(
        tmp_path,
        "# Use Case Document\n\n## 2. High-Level Use Case List\n- UC-001. User performs goal\n",
    )
    write_use_case_slice(tmp_path, "UC-001")

    result = start_use_cases(tmp_path)

    assert result.use_cases_ready is True
    assert result.active_stage == "useCases"


def test_harvest_ui_accepts_heading_canonical_use_case_entries(tmp_path: Path) -> None:
    write_passed_requirements(tmp_path)
    write_canonical_use_cases(
        tmp_path,
        "# Use Case Document\n\n## UC-001. User performs goal\n",
    )
    write_use_case_slice(tmp_path, "UC-001")

    result = start_use_case_generation(tmp_path, "build a queue system")

    assert result.use_cases_ready is True
    assert result.active_stage == "useCases"


def test_harvest_ui_names_missing_matching_use_case_slice_files(tmp_path: Path) -> None:
    write_passed_requirements(tmp_path)
    write_canonical_use_cases(
        tmp_path,
        "# Use Case Document\n\n## 2. High-Level Use Case List\n- UC-001. User performs goal\n",
    )
    use_case_dir = tmp_path / "docs/use-cases/UC-001"
    use_case_dir.mkdir(parents=True, exist_ok=True)
    (use_case_dir / "use-case.md").write_text(
        "# UC-001. User performs goal\n\n## Goal\n- Perform goal.\n",
        encoding="utf-8",
    )

    with pytest.raises(
        ValueError,
        match=r"docs/use-cases/UC-001/e2e-goal\.md",
    ):
        start_use_cases(tmp_path)


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

    with pytest.raises(
        ValueError,
        match=re.escape(
            "use-case harvest reported complete but docs/design/유스케이스.md is missing, empty, or has no parseable UC entries. Expected '- UC-001. ...' or '## UC-001. ...'."
        ),
    ):
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


def test_harvest_ui_clears_stale_ready_flag_when_canonical_use_cases_invalid(tmp_path: Path) -> None:
    write_passed_requirements(tmp_path)
    write_canonical_use_cases(tmp_path, " \n")
    session_path = tmp_path / ".harness/ui/harvest-session.json"
    session_path.parent.mkdir(parents=True, exist_ok=True)
    session_path.write_text(
        json.dumps(
            {
                "initial_prompt": "calculator",
                "clarifications": [],
                "current_question": None,
                "current_questions": [],
                "pending_questions": [],
                "requirements_gate_passed": True,
                "active_stage": "useCases",
                "use_cases_ready": True,
                "runtime_error": "",
                "draft_context_markdown": "",
                "draft_requirements_markdown": "",
                "use_case_clarifications": [],
                "use_case_current_question": None,
                "use_case_current_questions": [],
                "use_case_pending_questions": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = load_harvest_ui(tmp_path)

    assert result.use_cases_ready is False
    assert result.active_stage == "requirements"
