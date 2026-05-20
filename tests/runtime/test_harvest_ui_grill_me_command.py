import json
import subprocess
from pathlib import Path

from harness_codex.runtime.harvest_ui import (
    GRILL_ME_SKILL_PATH,
    _grill_me_prompt,
    _parse_grill_me_json,
    _run_grill_me,
)


def _write_skills(root: Path) -> None:
    skill_path = root / GRILL_ME_SKILL_PATH
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Grill Me\n", encoding="utf-8")
    requirements_skill = root / ".codex/skills/harness-requirements/SKILL.md"
    requirements_skill.parent.mkdir(parents=True, exist_ok=True)
    requirements_skill.write_text("# Requirements\n", encoding="utf-8")


def test_grill_me_command_skips_git_repo_check(tmp_path: Path, monkeypatch) -> None:
    _write_skills(tmp_path)

    captured = {}

    def fake_run(command, **kwargs):
        captured["command"] = command
        final_message_path = Path(command[command.index("--output-last-message") + 1])
        final_message_path.write_text(
            json.dumps({"complete": True, "questions": []}),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = _run_grill_me(
        tmp_path,
        {
            "initial_prompt": "build feature",
            "clarifications": [],
        },
    )

    assert result == {"complete": True, "questions": []}
    assert "--skip-git-repo-check" in captured["command"]
    assert captured["command"].index("--skip-git-repo-check") > captured["command"].index(str(tmp_path))


def test_grill_me_prompt_prefers_dense_decision_bundle_questions(tmp_path: Path) -> None:
    _write_skills(tmp_path)

    prompt = _grill_me_prompt(
        tmp_path,
        {
            "initial_prompt": "queue system",
            "clarifications": [],
            "current_question": None,
            "current_questions": [],
            "pending_questions": [],
        },
        tmp_path / GRILL_ME_SKILL_PATH,
    )

    assert "return up to exactly 3 questions" in prompt
    assert "do not reduce the per-round maximum" in prompt
    assert "dense decision-bundle questions" in prompt
    assert "Actor / Trigger / Success Outcome / Failure Policy" in prompt
    assert "recommended default answer" in prompt
    assert "mostly OK except" in prompt
    assert "enough to draft at least one concrete use case" in prompt
    assert "Do not keep asking until every detail is resolved" in prompt


def test_grill_me_parser_still_allows_up_to_three_questions() -> None:
    result = _parse_grill_me_json(
        json.dumps(
            {
                "complete": False,
                "questions": [
                    {"question": "Q1", "recommended": "A1"},
                    {"question": "Q2", "recommended": "A2"},
                    {"question": "Q3", "recommended": "A3"},
                    {"question": "Q4", "recommended": "A4"},
                ],
            }
        )
    )

    assert [item["question"] for item in result["questions"]] == ["Q1", "Q2", "Q3"]
