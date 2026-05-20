import json
import subprocess
from pathlib import Path

import pytest

from harness_codex.runtime.harvest_ui import (
    GRILL_ME_SKILL_PATH,
    REQUIREMENTS_PATH,
    _grill_me_prompt,
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


def test_grill_me_prompt_uses_bounded_document_snapshot(tmp_path: Path) -> None:
    _write_skills(tmp_path)
    (tmp_path / REQUIREMENTS_PATH).parent.mkdir(parents=True, exist_ok=True)
    large_body = "\n".join(f"- repeated requirement line {index}" for index in range(2000))
    (tmp_path / REQUIREMENTS_PATH).write_text(
        "# Requirements\n\n## Relevant\n- payment queue\n\n## Very Large Section\n" + large_body,
        encoding="utf-8",
    )

    prompt = _grill_me_prompt(
        tmp_path,
        {
            "initial_prompt": "payment queue",
            "clarifications": [],
            "current_question": None,
            "current_questions": [],
            "pending_questions": [],
        },
        tmp_path / GRILL_ME_SKILL_PATH,
    )

    assert "Repository context snapshot" in prompt
    assert "Full documents and raw stdout/stderr are source artifacts" in prompt
    assert '"truncated": true' in prompt
    assert "repeated requirement line 1999" not in prompt
    assert str(REQUIREMENTS_PATH) in prompt


def test_grill_me_failure_reports_tail_and_log_paths(tmp_path: Path, monkeypatch) -> None:
    _write_skills(tmp_path)

    def fake_run(command, **kwargs):
        stdout = "\n".join(f"out {index}" for index in range(80))
        stderr = "\n".join(f"err {index}" for index in range(260))
        return subprocess.CompletedProcess(command, 2, stdout=stdout, stderr=stderr)

    monkeypatch.setattr(subprocess, "run", fake_run)

    with pytest.raises(ValueError) as exc_info:
        _run_grill_me(
            tmp_path,
            {
                "initial_prompt": "build feature",
                "clarifications": [],
            },
        )

    message = str(exc_info.value)
    assert "stdout_tail" in message
    assert "stderr_tail" in message
    assert "full_log_path" in message
    assert "out 0" not in message
    assert "out 79" in message
    assert "err 0" not in message
    assert "err 259" in message

    run_dirs = list((tmp_path / ".harness/ui/grill-me-runs").iterdir())
    assert len(run_dirs) == 1
    run_dir = run_dirs[0]
    assert (run_dir / "stdout.log").is_file()
    assert (run_dir / "stderr.log").is_file()
    assert (run_dir / "stdout.tail.log").is_file()
    assert (run_dir / "stderr.tail.log").is_file()
    report = json.loads((run_dir / "run-report.json").read_text(encoding="utf-8"))
    assert report["exit_code"] == 2
    assert report["logs"]["stdout_path"].endswith("stdout.log")
    assert report["logs"]["stderr_tail_path"].endswith("stderr.tail.log")
