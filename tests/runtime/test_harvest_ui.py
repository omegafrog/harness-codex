from pathlib import Path

import json
import re
import subprocess
import pytest

from harness_codex.runtime.harvest_ui import (
    CONTEXT_PATH,
    REQUIREMENTS_PATH,
    USE_CASES_PATH,
    activate_changeset_harvest_ui,
    advance_ddd_architecture,
    advance_event_storming,
    answer_ddd_architecture,
    answer_event_storming,
    answer_use_cases,
    answer_requirements,
    complete_ubiquitous_language,
    load_changeset_harvest_ui,
    load_harvest_ui,
    rerun_ddd_architecture_step,
    restart_ddd_architecture,
    save_changeset_harvest_ui,
    start_requirements,
    start_ddd_architecture,
    start_event_storming,
    start_ubiquitous_language,
    start_use_case_generation,
    start_use_cases,
    _ddd_turn_contract,
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
    (root / CONTEXT_PATH).write_text(
        "# Project Context\n\n"
        "## 1. Ubiquitous Language\n\n"
        "| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |\n"
        "|---|---|---|---|---|---|---|---|\n"
        "| User | 사용자 | User | Actor | Primary actor. | - | - | requirements |\n\n"
        "## 2. Naming Rules\n\n- Documents must use `Canonical Term`.\n\n"
        "## 3. Open Language Questions\n\n- None.\n",
        encoding="utf-8",
    )
    start_ubiquitous_language(root)
    complete_ubiquitous_language(root)


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


def write_event_storming_slice(root: Path, uc_id: str) -> None:
    path = root / f"docs/use-cases/{uc_id}/event-storming.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""# {uc_id}. Event Storming

## Flow
### [Flow: Main Flow]
🟦 Start {uc_id}
→ 🟧 {uc_id} was started
→ 🟪 {uc_id} is valid
""",
        encoding="utf-8",
    )


def write_ddd_slice(root: Path, uc_id: str, step_id: str) -> None:
    sections = {
        "entity_vo": """## Impact Assessment
|Element Type|Element|Status|Baseline Evidence|Event Storming Evidence|
|---|---|---|---|---|
|Aggregate|Note|new|No existing design|Start UC|

## Entity / Value Objects
|Entity|Attributes / VOs|Status|Previous Definition|Proposed Definition|Evidence|
|---|---|---|---|---|---|
|Note|id: NoteId (required, Start UC); content: Content (required, Start UC); Content { text: String } (non-empty)|new|-|id: NoteId; content: Content; Content { text: String }|Start UC|
""",
        "behaviors": """## Behaviors
|Owner / Service|Signature|Participants|Placement|Policy Evidence|
|---|---|---|---|---|
|Note|open(NoteId id)|Note|entity method|UC is valid|
""",
        "application_flow": """## Application Flow
|Application Service|Signature|Description|Calls|Evidence|
|---|---|---|---|---|
|OpenNoteApplicationService|open(NoteId id)|Load the note, delegate opening to the aggregate, save state, and return opened-note view data.|Note.open(id)|Start UC|
""",
        "aggregates": """## Aggregates
|Aggregate|Aggregate Root|Members|Atomic Invariant|Evidence|
|---|---|---|---|---|
|Note|Note|Note, NoteId|Note opens atomically|UC was started|
""",
        "bounded_contexts": """## Bounded Contexts
|Bounded Context|Owned Aggregates / Entities|Boundary Reason|Communication Type|Target BC|Evidence|
|---|---|---|---|---|---|
|Notes|Note|Consistent note meaning|None|-|UC is valid|
""",
    }
    order = ["entity_vo", "behaviors", "application_flow", "aggregates", "bounded_contexts"]
    end = order.index(step_id) + 1
    path = root / f"docs/use-cases/{uc_id}/ddd-design.md"
    path.write_text(f"# {uc_id}. DDD Design\n\n" + "\n".join(sections[current] for current in order[:end]), encoding="utf-8")


def mark_event_storming_complete(root: Path, uc_ids: list[str]) -> None:
    session_path = root / ".harness/ui/harvest-session.json"
    session = json.loads(session_path.read_text(encoding="utf-8"))
    session["event_storming"] = {
        "uc_ids": uc_ids,
        "items": {uc_id: {"status": "complete"} for uc_id in uc_ids},
        "current_uc": None,
        "completed_count": len(uc_ids),
        "complete": True,
        "status": "complete",
    }
    session["active_stage"] = "eventStorming"
    session_path.write_text(json.dumps(session), encoding="utf-8")
    for uc_id in uc_ids:
        write_event_storming_slice(root, uc_id)


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
    assert not (tmp_path / CONTEXT_PATH).exists()
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
    assert result.language_gate_passed is False
    assert result.use_cases_ready is False
    assert result.current_question is None
    assert "Question | Response" in (tmp_path / REQUIREMENTS_PATH).read_text(encoding="utf-8")
    assert not (tmp_path / CONTEXT_PATH).exists()

    result = start_ubiquitous_language(tmp_path)
    assert result.active_stage == "ubiquitousLanguage"
    assert (tmp_path / CONTEXT_PATH).is_file()
    result = complete_ubiquitous_language(tmp_path)
    assert result.language_gate_passed is True

    write_runtime_ready_use_cases(tmp_path)
    result = start_use_cases(tmp_path)

    assert result.active_stage == "useCases"
    assert result.use_cases_ready is True
    assert (tmp_path / USE_CASES_PATH).is_file()


def test_harvest_ui_presents_and_answers_three_requirements_questions_together(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def batched_grill_me(_root: Path, session: dict) -> dict:
        complete = len(session["clarifications"]) == 3
        return {
            "complete": complete,
            "questions": [] if complete else [
                {"question": "Who is the actor?", "recommended": "Customer"},
                {"question": "What is success?", "recommended": "Request accepted"},
                {"question": "What failure matters?", "recommended": "Invalid request rejected"},
            ],
            "requirements_markdown": "# Requirements Specification\n",
            "context_markdown": "# Project Context\n\n## 3. Open Language Questions\n\n- None.\n",
        }

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", batched_grill_me)

    result = start_requirements(tmp_path, "build a queue system")

    assert [item["question"] for item in result.current_questions] == [
        "Who is the actor?",
        "What is success?",
        "What failure matters?",
    ]

    with pytest.raises(ValueError, match="one answer is required"):
        answer_requirements(tmp_path, ["Customer"])

    result = answer_requirements(
        tmp_path,
        ["Customer", "Request accepted", "Invalid request rejected"],
    )

    assert result.requirements_gate_passed is True
    assert [item["answer"] for item in result.clarifications] == [
        "Customer",
        "Request accepted",
        "Invalid request rejected",
    ]
    assert [item["questions"][0]["question"] for item in result.clarifications] == [
        "Who is the actor?",
        "What is success?",
        "What failure matters?",
    ]


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
    assert result.active_stage == "ubiquitousLanguage"
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


def test_harvest_ui_requirements_finalization_ignores_context_markdown(
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

    assert result.requirements_gate_passed is True
    assert result.current_question is None
    assert not (tmp_path / CONTEXT_PATH).exists()


def test_harvest_ui_requirements_question_loop_does_not_use_open_language_questions(
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

    assert result.requirements_gate_passed is True
    assert result.current_question is None
    assert not (tmp_path / CONTEXT_PATH).exists()


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
        Path(".codex/skills/harness-requirements/SKILL.md"),
        Path(".codex/skills/harness-ubiquitous-language/SKILL.md"),
    )

    assert "Compact Q/A history" in prompt
    assert "requirements_markdown" in prompt
    assert "Return only JSON with keys: complete, questions, requirements_markdown." in prompt
    assert "Always include draft requirements_markdown" in prompt
    assert "Harness requirements standards" in prompt
    assert ".codex/skills/harness-requirements/SKILL.md" in prompt
    assert ".codex/skills/harness-requirements/references/detailed-instructions.md" in prompt
    assert "Load `.codex/skills/harness-ubiquitous-language/SKILL.md`" not in prompt
    assert ".codex/skills/harness-ubiquitous-language/references/detailed-instructions.md" not in prompt
    assert "Do not produce `context_markdown`" in prompt


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


def test_harvest_ui_blocks_use_cases_until_ubiquitous_language_is_confirmed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
    start_requirements(tmp_path, "build a queue system")
    answer_requirements(tmp_path, "answer 1")
    answer_requirements(tmp_path, "answer 2")
    result = answer_requirements(tmp_path, "answer 3")

    assert result.requirements_gate_passed is True
    assert result.language_gate_passed is False
    assert not (tmp_path / CONTEXT_PATH).exists()
    with pytest.raises(ValueError, match="ubiquitous-language gate has not passed"):
        start_use_case_generation(tmp_path, "build a queue system")

    result = start_ubiquitous_language(tmp_path)
    assert result.active_stage == "ubiquitousLanguage"
    result = complete_ubiquitous_language(tmp_path)
    assert result.language_gate_passed is True


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
    complete_ubiquitous_language(tmp_path)

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
    complete_ubiquitous_language(tmp_path)
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
    assert result.active_stage == "ubiquitousLanguage"


def test_event_storming_processes_use_case_queue_and_resumes_question(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_passed_requirements(tmp_path)
    write_canonical_use_cases(
        tmp_path,
        "# Use Case Document\n\n- UC-001. First goal\n- UC-002. Second goal\n",
    )
    write_use_case_slice(tmp_path, "UC-001")
    write_use_case_slice(tmp_path, "UC-002")
    start_use_cases(tmp_path)
    calls: list[tuple[str, int]] = []

    def fake_event_storming(_root: Path, session: dict, _change_set_id: str, uc_id: str) -> dict:
        item = session["event_storming"]["items"][uc_id]
        calls.append((uc_id, len(item["clarifications"])))
        if uc_id == "UC-002" and not item["clarifications"]:
            return {
                "status": "needs_input",
                "questions": [{"question": "Which failure result?", "recommended": "Show error."}],
                "changed_files": [],
                "blocker": "",
            }
        write_event_storming_slice(tmp_path, uc_id)
        return {"status": "complete", "questions": [], "changed_files": [], "blocker": ""}

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_event_storming", fake_event_storming)

    first = start_event_storming(tmp_path, "CHG-001")
    paused = advance_event_storming(tmp_path, "CHG-001")
    completed = answer_event_storming(tmp_path, "CHG-001", "UC-002", "Show error.")

    assert first.event_storming["items"]["UC-001"]["status"] == "complete"
    assert paused.current_question["question"] == "Which failure result?"
    assert completed.event_storming["complete"] is True
    assert completed.active_stage == "eventStorming"
    assert calls == [("UC-001", 0), ("UC-002", 0), ("UC-002", 1)]


def test_changeset_snapshot_excludes_stale_event_output_until_stage_completes(tmp_path: Path) -> None:
    write_passed_requirements(tmp_path)
    write_runtime_ready_use_cases(tmp_path)
    start_use_cases(tmp_path)
    write_event_storming_slice(tmp_path, "UC-001")
    write_active_changeset(tmp_path, "CHG-001")

    save_changeset_harvest_ui(tmp_path, "CHG-001")

    assert not (
        tmp_path / ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/event-storming.md"
    ).exists()


def test_changeset_resume_restores_event_storming_question_without_runtime_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_passed_requirements(tmp_path)
    write_runtime_ready_use_cases(tmp_path)
    start_use_cases(tmp_path)
    write_active_changeset(tmp_path, "CHG-001")
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_event_storming",
        lambda *_args: {
            "status": "needs_input",
            "questions": [{"question": "Confirm policy?", "recommended": "Confirm."}],
            "changed_files": [],
            "blocker": "",
        },
    )
    start_event_storming(tmp_path, "CHG-001")
    save_changeset_harvest_ui(tmp_path, "CHG-001")
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_event_storming",
        lambda *_args: pytest.fail("resume must not execute oracle"),
    )

    result = load_changeset_harvest_ui(tmp_path, "CHG-001")

    assert result.active_stage == "eventStorming"
    assert result.current_question["question"] == "Confirm policy?"


def test_ddd_architecture_requires_explicit_substeps_and_resumes_answer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_passed_requirements(tmp_path)
    write_runtime_ready_use_cases(tmp_path)
    start_use_cases(tmp_path)
    mark_event_storming_complete(tmp_path, ["UC-001"])
    calls: list[tuple[str, int]] = []

    def fake_ddd(_root: Path, session: dict, _change_set_id: str, uc_id: str, step_id: str) -> dict:
        step = session["ddd_architecture"]["items"][uc_id]["steps"][step_id]
        calls.append((step_id, len(step["clarifications"])))
        if step_id == "behaviors" and not step["clarifications"]:
            return {"status": "needs_input", "questions": [{"question": "Own policy?", "recommended": "Entity."}], "changed_files": [], "blocker": "", "impact": {}}
        write_ddd_slice(tmp_path, uc_id, step_id)
        return {"status": "complete", "questions": [], "changed_files": [], "blocker": "", "impact": {"aggregate": "new"}}

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_ddd_architecture", fake_ddd)

    entity = start_ddd_architecture(tmp_path, "CHG-001")
    paused = advance_ddd_architecture(tmp_path, "CHG-001")
    behavior = answer_ddd_architecture(tmp_path, "CHG-001", "UC-001", "behaviors", "Entity.")
    application = advance_ddd_architecture(tmp_path, "CHG-001")
    aggregate = advance_ddd_architecture(tmp_path, "CHG-001")
    complete = advance_ddd_architecture(tmp_path, "CHG-001")

    assert entity.ddd_architecture["items"]["UC-001"]["steps"]["entity_vo"]["status"] == "complete"
    assert entity.ddd_architecture["items"]["UC-001"]["steps"]["behaviors"]["status"] == "pending"
    assert paused.current_question["question"] == "Own policy?"
    assert behavior.ddd_architecture["items"]["UC-001"]["steps"]["behaviors"]["status"] == "complete"
    assert application.ddd_architecture["items"]["UC-001"]["steps"]["application_flow"]["status"] == "complete"
    assert aggregate.ddd_architecture["items"]["UC-001"]["steps"]["aggregates"]["status"] == "complete"
    assert complete.ddd_architecture["complete"] is True
    assert calls == [("entity_vo", 0), ("behaviors", 0), ("behaviors", 1), ("application_flow", 0), ("aggregates", 0), ("bounded_contexts", 0)]


def test_ddd_turn_contract_does_not_ask_for_representation_implied_by_slice() -> None:
    prompt = _ddd_turn_contract(
        "CHG-001",
        "UC-001",
        "entity_vo",
        {"steps": {"entity_vo": {"rerun_prompts": []}}},
    )

    assert "Do not ask the user to choose a representation already implied" in prompt
    assert "When slice evidence fully implies one model shape" in prompt
    assert "without presenting alternatives as a question" in prompt
    assert "serialization mechanics" in prompt


def test_rerun_ddd_architecture_step_records_prompt_and_keeps_other_steps_complete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_passed_requirements(tmp_path)
    write_runtime_ready_use_cases(tmp_path)
    start_use_cases(tmp_path)
    mark_event_storming_complete(tmp_path, ["UC-001"])
    application_flow_calls = 0

    def fake_ddd(_root: Path, session: dict, _change_set_id: str, uc_id: str, step_id: str) -> dict:
        nonlocal application_flow_calls
        if step_id == "application_flow":
            application_flow_calls += 1
            prompts = session["ddd_architecture"]["items"][uc_id]["steps"][step_id].get("rerun_prompts", [])
            if application_flow_calls == 2:
                assert prompts == ["Use prose only and keep service signature visible."]
        write_ddd_slice(tmp_path, uc_id, step_id)
        return {"status": "complete", "questions": [], "changed_files": [], "blocker": "", "impact": {}}

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_ddd_architecture", fake_ddd)

    start_ddd_architecture(tmp_path, "CHG-001")
    advance_ddd_architecture(tmp_path, "CHG-001")
    advance_ddd_architecture(tmp_path, "CHG-001")
    advance_ddd_architecture(tmp_path, "CHG-001")
    complete = advance_ddd_architecture(tmp_path, "CHG-001")
    assert complete.ddd_architecture["complete"] is True

    result = rerun_ddd_architecture_step(
        tmp_path,
        "CHG-001",
        "UC-001",
        "application_flow",
        "Use prose only and keep service signature visible.",
    )

    steps = result.ddd_architecture["items"]["UC-001"]["steps"]
    assert steps["application_flow"]["status"] == "complete"
    assert steps["application_flow"]["rerun_prompts"] == ["Use prose only and keep service signature visible."]
    assert steps["aggregates"]["status"] == "complete"
    assert steps["bounded_contexts"]["status"] == "complete"
    assert result.ddd_architecture["complete"] is True


def test_rerun_ddd_architecture_step_allows_empty_prompt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_passed_requirements(tmp_path)
    write_runtime_ready_use_cases(tmp_path)
    start_use_cases(tmp_path)
    mark_event_storming_complete(tmp_path, ["UC-001"])

    def fake_ddd(_root: Path, session: dict, _change_set_id: str, uc_id: str, step_id: str) -> dict:
        prompts = session["ddd_architecture"]["items"][uc_id]["steps"][step_id].get("rerun_prompts", [])
        assert prompts == []
        write_ddd_slice(tmp_path, uc_id, step_id)
        return {"status": "complete", "questions": [], "changed_files": [], "blocker": "", "impact": {}}

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_ddd_architecture", fake_ddd)

    start_ddd_architecture(tmp_path, "CHG-001")
    result = rerun_ddd_architecture_step(tmp_path, "CHG-001", "UC-001", "entity_vo", "   ")

    steps = result.ddd_architecture["items"]["UC-001"]["steps"]
    assert steps["entity_vo"]["status"] == "complete"
    assert steps["entity_vo"].get("rerun_prompts", []) == []


def test_changeset_resume_restores_ddd_question_without_agent_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_passed_requirements(tmp_path)
    write_runtime_ready_use_cases(tmp_path)
    start_use_cases(tmp_path)
    mark_event_storming_complete(tmp_path, ["UC-001"])
    write_active_changeset(tmp_path, "CHG-001")
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_ddd_architecture",
        lambda *_args: {"status": "needs_input", "questions": [{"question": "New aggregate?", "recommended": "Reuse."}], "changed_files": [], "blocker": "", "impact": {}},
    )
    start_ddd_architecture(tmp_path, "CHG-001")
    save_changeset_harvest_ui(tmp_path, "CHG-001")
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_ddd_architecture",
        lambda *_args: pytest.fail("resume must not execute ddd_architect"),
    )

    result = load_changeset_harvest_ui(tmp_path, "CHG-001")

    assert result.active_stage == "dddArchitecture"
    assert result.current_question["question"] == "New aggregate?"


def test_restart_ddd_architecture_replaces_existing_scoped_design(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_passed_requirements(tmp_path)
    write_runtime_ready_use_cases(tmp_path)
    start_use_cases(tmp_path)
    mark_event_storming_complete(tmp_path, ["UC-001"])
    session_path = tmp_path / ".harness/ui/harvest-session.json"
    session = json.loads(session_path.read_text(encoding="utf-8"))
    session["ddd_architecture"] = {
        "uc_ids": ["UC-001"],
        "items": {
            "UC-001": {
                "status": "complete",
                "steps": {
                    step_id: {"label": label, "status": "complete", "current_question": None, "clarifications": [], "error": ""}
                    for step_id, label in (
                        ("entity_vo", "Entity / Value Objects"),
                        ("behaviors", "Behaviors"),
                        ("application_flow", "Application Flow"),
                        ("aggregates", "Aggregates"),
                        ("bounded_contexts", "Bounded Contexts"),
                    )
                },
            }
        },
        "current_uc": None,
        "current_step": "bounded_contexts",
        "completed_count": 5,
        "complete": True,
        "status": "complete",
    }
    session_path.write_text(json.dumps(session), encoding="utf-8")
    stale_design = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
    stale_design.write_text("# stale DDD\n", encoding="utf-8")
    (tmp_path / "ARCHITECTURE.md").write_text("# stale architecture\n", encoding="utf-8")
    calls: list[tuple[str, str]] = []

    def fake_ddd(_root: Path, _session: dict, _change_set_id: str, uc_id: str, step_id: str) -> dict:
        calls.append((uc_id, step_id))
        write_ddd_slice(tmp_path, uc_id, step_id)
        return {"status": "complete", "questions": [], "changed_files": [], "blocker": "", "impact": {}}

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_ddd_architecture", fake_ddd)

    result = restart_ddd_architecture(tmp_path, "CHG-001")

    assert calls == [("UC-001", "entity_vo")]
    assert result.ddd_architecture["items"]["UC-001"]["steps"]["entity_vo"]["status"] == "complete"
    assert result.ddd_architecture["items"]["UC-001"]["steps"]["behaviors"]["status"] == "pending"
    assert "stale DDD" not in stale_design.read_text(encoding="utf-8")
    assert not (tmp_path / "ARCHITECTURE.md").exists()


def test_ddd_entity_vo_validation_accepts_typed_core_attributes_table(tmp_path: Path) -> None:
    from harness_codex.runtime.harvest_ui import _validate_ddd_design_slice

    path = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        """# UC-001 DDD Design

## Impact Assessment
| Area | Decision | Impact | Evidence |
| --- | --- | --- | --- |
| Workspace-backed note browsing domain | `new` | New model. | Expand selected Note Folder |

## Entity / Value Objects
| Model | Kind | Classification | Identity / Equality | Core attributes | Constructor / validation rules | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `MarkdownNote` | Entity | `new` | `notePath` identity. | `notePath: WorkspaceRelativePath`, `displayName: String`, `content: MarkdownDocumentContent` | Must be a visible `.md` file. | Open selected Markdown Note |
""",
        encoding="utf-8",
    )

    assert _validate_ddd_design_slice(path, "entity_vo") == (True, "")


def test_ddd_entity_vo_validation_accepts_proposed_identity_state_table(tmp_path: Path) -> None:
    from harness_codex.runtime.harvest_ui import _validate_ddd_design_slice

    path = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        """# UC-001 DDD Design

## Impact Assessment
| Area | Decision | Impact | Evidence |
| --- | --- | --- | --- |
| Workspace-backed explorer domain | `new` | New model. | Open selected Markdown Note |

## Entity / Value Objects
| Model | Kind | Proposed Identity / State | Why new |
| --- | --- | --- | --- |
| `MarkdownNote` | Entity | `WorkspaceRelativePath path`, openable file content loaded from that path | Path identity matters. |
| `WorkspaceRelativePath` | Value Object | Normalized relative path constrained beneath `NoteWorkspace` | Prevents escaping root. |

### Evidence
- Open selected Markdown Note.
""",
        encoding="utf-8",
    )

    assert _validate_ddd_design_slice(path, "entity_vo") == (True, "")


def test_ddd_entity_vo_validation_accepts_type_first_attributes(tmp_path: Path) -> None:
    from harness_codex.runtime.harvest_ui import _validate_ddd_design_slice

    path = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        """# UC-001 DDD Design

## Impact Assessment
|Element Type|Element|Status|Baseline Evidence|Event Storming Evidence|
|---|---|---|---|---|
|Entity|MarkdownNote|new|No existing design|Open selected Markdown Note|

## Entity / Value Objects
|Entity|Attributes / VOs|Status|Previous Definition|Proposed Definition|Evidence|
|---|---|---|---|---|---|
|MarkdownNote|WorkspaceRelativePath path|new|-|WorkspaceRelativePath path|Open selected Markdown Note|
""",
        encoding="utf-8",
    )

    assert _validate_ddd_design_slice(path, "entity_vo") == (True, "")


def test_ddd_aggregate_validation_rejects_placeholder_name(tmp_path: Path) -> None:
    from harness_codex.runtime.harvest_ui import _validate_ddd_design_slice

    path = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        """# UC-001 DDD Design

## Impact Assessment
|Element Type|Element|Status|Baseline Evidence|Event Storming Evidence|
|---|---|---|---|---|
|Entity|MarkdownNote|new|No existing design|Open selected Markdown Note|

## Entity / Value Objects
|Entity|Attributes / VOs|Status|Previous Definition|Proposed Definition|Evidence|
|---|---|---|---|---|---|
|MarkdownNote|path: WorkspaceRelativePath|required|-|path: WorkspaceRelativePath|Open selected Markdown Note|

## Behaviors
|Owner / Service|Signature|Participants|Placement|Policy Evidence|
|---|---|---|---|---|
|MarkdownNote|open(path: WorkspaceRelativePath)|MarkdownNote|entity method|Open selected Markdown Note|

## Application Flow
|Application Service|Signature|Description|Calls|Evidence|
|---|---|---|---|---|
|OpenNoteApplicationService|open(path: WorkspaceRelativePath)|Load note and delegate opening.|MarkdownNote.open(path)|Open selected Markdown Note|

## Aggregates
|Aggregate|Aggregate Root|Members|Atomic Invariant|Evidence|
|---|---|---|---|---|
|Aggregate|MarkdownNote|MarkdownNote|Open atomically|Open selected Markdown Note|
""",
        encoding="utf-8",
    )

    ready, error = _validate_ddd_design_slice(path, "aggregates")

    assert ready is False
    assert "explicit aggregate name" in error


def test_ddd_visualization_splits_br_aggregate_members() -> None:
    script = Path("harness_codex/runtime/dashboard_assets/dashboard.js").read_text(encoding="utf-8")
    script = script.split("loadDashboard().catch", 1)[0]
    markdown = """# UC-001 DDD Design

## Impact Assessment
|Element Type|Element|Status|Baseline Evidence|Event Storming Evidence|
|---|---|---|---|---|
|Entity|`FleetingNote`|modify|Existing note.|Stored note keeps images.|
|Entity|`InsertedImage`|new|No image entity.|Each image has source.|
|Value Object|`ImageSource`|new|No source VO.|Each image has source.|

## Entity / Value Objects
|Entity|Attributes / VOs|Status|Previous Definition|Proposed Definition|Evidence|
|---|---|---|---|---|---|
|`FleetingNote`|`insertedImages: List<InsertedImage>`|modify|None.|Images kept.|Save note with images.|
|`InsertedImage`|`source: ImageSource`|new|None.|Source required.|Record source.|
|`ImageSource`|`value: String`|new|None.|Non-empty source.|Source required.|

## Behaviors
|Owner / Service|Signature|Participants|Placement|Policy Evidence|
|---|---|---|---|---|
|`FleetingNote`|`assertSaveable(): void`|`InsertedImage`|`entity`|Every image needs source.|

## Application Flow
|Application Service|Signature|Description|Calls|Evidence|
|---|---|---|---|---|
|`SaveFleetingNoteApplicationService`|`saveNewFleetingNote(): SaveFleetingNoteResult`|Persist completed note.|`FleetingNote.assertSaveable()`|Save note.|

## Aggregates
|Aggregate|Aggregate Root|Members|Atomic Invariant|Evidence|
|---|---|---|---|---|
|`FleetingNoteCapture`|`FleetingNote`|`InsertedImage`<br>`ImageSource`|Note and images saved together.|Save note.|

## Bounded Contexts
|Bounded Context|Owned Aggregates / Entities|Boundary Reason|Communication Type|Target BC|Evidence|
|---|---|---|---|---|---|
|`Fleeting Note Capture`|`FleetingNoteCapture`<br>`FleetingNote`<br>`InsertedImage`|Owns save flow.|`internal_http`|`Image Asset Intake`|Same user action needs accepted image result.|
|`Image Asset Intake`|None in this slice.|Owns file acceptance.|`internal_http`|`Fleeting Note Capture`|Invalid file rejected synchronously.|
"""
    node_test = f"""
{script}
const board = parseDddMarkdown({json.dumps(markdown)});
const html = renderDddVisualization(board, "bounded_contexts");
const preview = markdownPreview({json.dumps(markdown)});
if (!html.includes("FleetingNoteCapture")) throw new Error("missing aggregate");
if (!html.includes("FleetingNote")) throw new Error("missing root entity");
if (!html.includes("InsertedImage")) throw new Error("missing br-split member entity");
if (!html.includes("ImageSource")) throw new Error("missing br-split value object");
if (!html.includes("Bounded Contexts")) throw new Error("missing bounded-context heading");
if ((html.match(/ddd-boundary context/g) || []).length !== 2) throw new Error("missing bounded-context cards");
if ((html.match(/ddd-context-owned-item/g) || []).length < 4) throw new Error("missing split bounded-context owned entries");
if (!html.includes("Fleeting Note Capture")) throw new Error("missing primary bounded context");
if (!html.includes("Image Asset Intake")) throw new Error("missing target bounded context");
if (!html.includes("internal_http -> Image Asset Intake")) throw new Error("missing bounded-context communication");
if (!preview.includes("<code>FleetingNoteCapture</code><br><code>FleetingNote</code><br><code>InsertedImage</code>")) throw new Error("bounded-context table br was escaped");
if (preview.includes("FleetingNoteCapture&lt;br")) throw new Error("bounded-context table still shows literal br");
"""
    subprocess.run(["node", "-e", node_test], check=True)


def test_ddd_instruction_mentions_aggregate_name_and_bottom_app_service_methods() -> None:
    text = Path("harness_codex/runtime/harvest_ui.py").read_text(encoding="utf-8")

    assert "never use the literal placeholder `Aggregate`" in text
    assert "bottom visualization area is an Application Service method list only" in text
    assert "typed attributes rendered as `Type attributeName`" in text
