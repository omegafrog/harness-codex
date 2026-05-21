from pathlib import Path

import json
import pytest

from harness_codex.runtime.interactive_harvest import (
    list_harvest_sessions,
    run_interactive_harvest,
)


class StopInput(Exception):
    pass


def _draft_documents(session: dict) -> dict:
    return {
        "requirements_markdown": "\n".join(
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
        ),
        "context_markdown": "\n".join(
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
                "",
                "## 3. Open Language Questions",
                "",
                "- None.",
            ]
        ),
    }


def _write_generated_use_cases(root: Path, _session_id: str, _idea: str) -> None:
    use_cases = root / "docs/design/유스케이스.md"
    use_cases.parent.mkdir(parents=True, exist_ok=True)
    use_cases.write_text(
        "# Use Case Document\n\n## 2. High-Level Use Case List\n- UC-001. User performs goal\n",
        encoding="utf-8",
    )
    uc_dir = root / "docs/use-cases/UC-001"
    uc_dir.mkdir(parents=True, exist_ok=True)
    (uc_dir / "use-case.md").write_text("# UC-001\n\n## Goal\n- Do it.\n", encoding="utf-8")
    (uc_dir / "e2e-goal.md").write_text(
        "# UC-001 E2E Goal\n\n## Given\n- Ready.\n\n## When\n- Act.\n\n## Then\n- Success.\n",
        encoding="utf-8",
    )


def _complete_use_case_harvest(root: Path, _session: dict, _idea: str) -> dict:
    _write_generated_use_cases(root, "", _idea)
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


def test_interactive_harvest_reuses_harvest_ui_gate(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls = []

    def fake_grill_me(_root: Path, session: dict) -> dict:
        calls.append(len(session["clarifications"]))
        if len(session["clarifications"]) >= 1:
            return {"complete": True, "questions": [], **_draft_documents(session)}
        return {
            "complete": False,
            "questions": [
                {
                    "question": "Who is the primary actor?",
                    "recommended": "Customer",
                }
            ],
            **_draft_documents(session),
        }

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
    monkeypatch.setattr("harness_codex.runtime.interactive_harvest._validate_interactive_context", lambda *_args: None)
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_use_case_harvest", _complete_use_case_harvest)
    output_lines: list[str] = []

    result = run_interactive_harvest(
        tmp_path,
        "build a queue system",
        session_id="harvest-test-001",
        input_func=lambda _prompt: "Customer uses the queue system.",
        output_func=output_lines.append,
    )

    assert calls == [0, 1]
    assert "INTERACTIVE HARVEST completed" in result
    assert "Session ID: harvest-test-001" in result
    assert "./harness changes create-from-design" in result
    assert any("Session ID: harvest-test-001" in line for line in output_lines)
    assert any("Who is the primary actor?" in line for line in output_lines)
    assert (tmp_path / "docs/design/요구사항.md").is_file()
    assert (tmp_path / "context.md").is_file()
    assert (tmp_path / "docs/design/유스케이스.md").is_file()
    assert (tmp_path / ".harness/ui/harvest-session.json").is_file()
    assert (tmp_path / ".harness/ui/sessions/harvest-test-001.json").is_file()


def test_interactive_harvest_creates_named_session_before_grill_me(
    tmp_path: Path,
    monkeypatch,
) -> None:
    def failing_grill_me(_root: Path, _session: dict) -> dict:
        raise ValueError("boom")

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", failing_grill_me)

    with pytest.raises(ValueError, match="boom"):
        run_interactive_harvest(
            tmp_path,
            "build a queue system",
            session_id="harvest-early-001",
            input_func=lambda _prompt: "unused",
            output_func=lambda _line: None,
        )

    session_path = tmp_path / ".harness/ui/sessions/harvest-early-001.json"
    assert session_path.is_file()
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["initial_prompt"] == "build a queue system"
    assert session["runtime_error"] == "question_generating"


def test_interactive_harvest_resumes_saved_session(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls = []

    def fake_grill_me(_root: Path, session: dict) -> dict:
        calls.append(len(session["clarifications"]))
        if len(session["clarifications"]) >= 1:
            return {"complete": True, "questions": [], **_draft_documents(session)}
        return {
            "complete": False,
            "questions": [
                {
                    "question": "Who is the primary actor?",
                    "recommended": "Customer",
                }
            ],
            **_draft_documents(session),
        }

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
    monkeypatch.setattr("harness_codex.runtime.interactive_harvest._validate_interactive_context", lambda *_args: None)
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_use_case_harvest", _complete_use_case_harvest)

    with pytest.raises(StopInput):
        run_interactive_harvest(
            tmp_path,
            "build a queue system",
            session_id="harvest-resume-001",
            input_func=lambda _prompt: (_ for _ in ()).throw(StopInput()),
            output_func=lambda _line: None,
        )

    assert (tmp_path / ".harness/ui/sessions/harvest-resume-001.json").is_file()

    result = run_interactive_harvest(
        tmp_path,
        "",
        session_id="harvest-resume-001",
        resume=True,
        input_func=lambda _prompt: "Customer uses the queue system.",
        output_func=lambda _line: None,
    )

    assert calls == [0, 1]
    assert "INTERACTIVE HARVEST completed" in result
    assert "Session ID: harvest-resume-001" in result
    assert (tmp_path / "docs/design/유스케이스.md").is_file()


def test_interactive_harvest_reopens_requirements_when_language_validation_fails(
    tmp_path: Path,
    monkeypatch,
) -> None:
    def fake_grill_me(_root: Path, session: dict) -> dict:
        if len(session["clarifications"]) >= 1:
            return {"complete": True, "questions": [], **_draft_documents(session)}
        return {
            "complete": False,
            "questions": [
                {
                    "question": "Who is the primary actor?",
                    "recommended": "Customer",
                }
            ],
            **_draft_documents(session),
        }

    validation_calls: list[int] = []

    def fake_validate(_root: Path, _session_id: str, _idea: str) -> None:
        validation_calls.append(1)
        if len(validation_calls) == 1:
            raise ValueError(
                "interactive harvest step failed: validate-context-language: BLOCKED: forbidden Ubiquitous Language terms found\n"
                "- docs/design/요구사항.md contains forbidden term: Arithmetic Expression"
            )

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
    monkeypatch.setattr("harness_codex.runtime.interactive_harvest._validate_interactive_context", fake_validate)
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_use_case_harvest", _complete_use_case_harvest)
    output_lines: list[str] = []
    answers = iter(
        [
            "Customer uses the queue system.",
            "Use Arithmetic Operation consistently.",
        ]
    )

    result = run_interactive_harvest(
        tmp_path,
        "build a queue system",
        session_id="harvest-language-retry-001",
        input_func=lambda _prompt: next(answers),
        output_func=output_lines.append,
    )

    assert len(validation_calls) == 2
    assert "INTERACTIVE HARVEST completed" in result
    assert any("Language validation blocked use-case generation." in line for line in output_lines)
    assert any("Arithmetic Expression" in line for line in output_lines)
    assert any("Which canonical term should replace it consistently" in line for line in output_lines)


def test_list_harvest_sessions_outputs_saved_sessions(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_grill_me",
        lambda _root, session: {"complete": True, "questions": [], **_draft_documents(session)},
    )
    monkeypatch.setattr("harness_codex.runtime.interactive_harvest._validate_interactive_context", lambda *_args: None)
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_use_case_harvest", _complete_use_case_harvest)

    run_interactive_harvest(
        tmp_path,
        "build a queue system",
        session_id="harvest-list-001",
        input_func=lambda _prompt: "unused",
        output_func=lambda _line: None,
    )

    output = list_harvest_sessions(tmp_path)

    assert "Session ID" in output
    assert "Stage" in output
    assert "Requirements Gate" in output
    assert "Use Cases" in output
    assert "Initial Idea" in output
    assert "harvest-list-001" in output
    assert "useCases" in output
    assert "passed" in output
    assert "yes" in output
    assert "build a queue system" in output


def test_list_harvest_sessions_reports_invalid_session_file(tmp_path: Path) -> None:
    session_dir = tmp_path / ".harness/ui/sessions"
    session_dir.mkdir(parents=True)
    (session_dir / "broken.json").write_text("not json", encoding="utf-8")

    output = list_harvest_sessions(tmp_path)

    assert "broken" in output
    assert "ERROR" in output
    assert "invalid session file" in output


def test_list_harvest_sessions_reports_empty_state(tmp_path: Path) -> None:
    assert list_harvest_sessions(tmp_path) == "No harvest sessions found"


def test_interactive_harvest_blocks_completed_session_resume(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_grill_me",
        lambda _root, session: {"complete": True, "questions": [], **_draft_documents(session)},
    )
    monkeypatch.setattr("harness_codex.runtime.interactive_harvest._validate_interactive_context", lambda *_args: None)
    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_use_case_harvest", _complete_use_case_harvest)

    run_interactive_harvest(
        tmp_path,
        "build a queue system",
        session_id="harvest-complete-001",
        input_func=lambda _prompt: "unused",
        output_func=lambda _line: None,
    )

    with pytest.raises(ValueError, match="harvest session already completed"):
        run_interactive_harvest(
            tmp_path,
            "",
            session_id="harvest-complete-001",
            resume=True,
            input_func=lambda _prompt: "unused",
            output_func=lambda _line: None,
        )


def test_interactive_harvest_requires_idea(tmp_path: Path) -> None:
    try:
        run_interactive_harvest(tmp_path, "  ")
    except ValueError as exc:
        assert "--idea is required" in str(exc)
    else:
        raise AssertionError("expected ValueError")
