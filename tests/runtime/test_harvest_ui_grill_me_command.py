import json
import subprocess
from pathlib import Path

import pytest

from harness_codex.runtime.harvest_ui import (
    GRILL_ME_SKILL_PATH,
    USE_CASE_DEFINITION_TIMEOUT_SEC,
    USE_CASE_AGENT_CONFIG_PATH,
    USE_CASE_SKILL_PATH,
    _run_grill_me,
    _run_use_case_harvest,
)


def test_grill_me_command_skips_git_repo_check(tmp_path: Path, monkeypatch) -> None:
    skill_path = tmp_path / GRILL_ME_SKILL_PATH
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Grill Me\n", encoding="utf-8")
    requirements_skill = tmp_path / ".codex/skills/harness-requirements/SKILL.md"
    requirements_skill.parent.mkdir(parents=True)
    requirements_skill.write_text("# Requirements\n", encoding="utf-8")

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


def test_use_case_timeout_returns_actionable_error(tmp_path: Path, monkeypatch) -> None:
    agent_config = tmp_path / USE_CASE_AGENT_CONFIG_PATH
    agent_config.parent.mkdir(parents=True)
    agent_config.write_text('name = "harness_usecases"\n', encoding="utf-8")
    skill_path = tmp_path / USE_CASE_SKILL_PATH
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Use Cases\n", encoding="utf-8")

    captured = {}

    def time_out(*_args, **kwargs):
        captured["timeout"] = kwargs["timeout"]
        raise subprocess.TimeoutExpired(["codex", "exec"], timeout=kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", time_out)

    with pytest.raises(
        ValueError,
        match="use-case definition timed out after 3600 seconds. Retry to continue from this stage.",
    ):
        _run_use_case_harvest(tmp_path, {"initial_prompt": "build feature", "use_case_clarifications": []}, "")

    assert captured["timeout"] == USE_CASE_DEFINITION_TIMEOUT_SEC == 3600
