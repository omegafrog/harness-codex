from pathlib import Path

from harness_codex.runtime.interactive_harvest import run_interactive_harvest


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
        input_func=lambda _prompt: "Customer uses the queue system.",
        output_func=output_lines.append,
    )

    assert calls == [0, 1]
    assert "INTERACTIVE HARVEST completed" in result
    assert "./harness changes create-from-design" in result
    assert any("Who is the primary actor?" in line for line in output_lines)
    assert (tmp_path / "docs/design/요구사항.md").is_file()
    assert (tmp_path / "docs/design/유스케이스.md").is_file()
    assert (tmp_path / ".harness/ui/harvest-session.json").is_file()


def test_interactive_harvest_requires_idea(tmp_path: Path) -> None:
    try:
        run_interactive_harvest(tmp_path, "  ")
    except ValueError as exc:
        assert "--idea is required" in str(exc)
    else:
        raise AssertionError("expected ValueError")
