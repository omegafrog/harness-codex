from pathlib import Path

import pytest

from harness_codex.runtime.interactive_harvest import run_interactive_harvest


class StopInput(Exception):
    pass


def test_interactive_harvest_reuses_harvest_ui_gate(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls = []

    def fake_grill_me(_root: Path, session: dict) -> dict:
        calls.append(len(session["clarifications"]))
        if len(session["clarifications"]) >= 1:
            return {"complete": True, "questions": []}
        return {
            "complete": False,
            "questions": [
                {
                    "question": "Who is the primary actor?",
                    "recommended": "Customer",
                }
            ],
        }

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)
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
    assert (tmp_path / "docs/design/유스케이스.md").is_file()
    assert (tmp_path / ".harness/ui/harvest-session.json").is_file()
    assert (tmp_path / ".harness/ui/sessions/harvest-test-001.json").is_file()


def test_interactive_harvest_resumes_saved_session(
    tmp_path: Path,
    monkeypatch,
) -> None:
    calls = []

    def fake_grill_me(_root: Path, session: dict) -> dict:
        calls.append(len(session["clarifications"]))
        if len(session["clarifications"]) >= 1:
            return {"complete": True, "questions": []}
        return {
            "complete": False,
            "questions": [
                {
                    "question": "Who is the primary actor?",
                    "recommended": "Customer",
                }
            ],
        }

    monkeypatch.setattr("harness_codex.runtime.harvest_ui._run_grill_me", fake_grill_me)

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


def test_interactive_harvest_blocks_completed_session_resume(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_grill_me",
        lambda _root, _session: {"complete": True, "questions": []},
    )

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
