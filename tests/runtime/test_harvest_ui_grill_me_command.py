import json
import subprocess
from pathlib import Path

import pytest

from harness_codex.runtime.harvest_ui import (
    DDD_AGENT_CONFIG_PATH,
    DDD_SKILL_PATH,
    DDD_TIMEOUT_SEC,
    EVENT_STORMING_AGENT_CONFIG_PATH,
    EVENT_STORMING_SKILL_PATH,
    EVENT_STORMING_TIMEOUT_SEC,
    GRILL_ME_SKILL_PATH,
    USE_CASE_DEFINITION_TIMEOUT_SEC,
    USE_CASE_AGENT_CONFIG_PATH,
    USE_CASE_SKILL_PATH,
    _run_grill_me,
    _run_ddd_architecture,
    _run_event_storming,
    _run_use_case_harvest,
)


def test_grill_me_command_skips_git_repo_check(tmp_path: Path, monkeypatch) -> None:
    skill_path = tmp_path / GRILL_ME_SKILL_PATH
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Grill Me\n", encoding="utf-8")
    requirements_skill = tmp_path / ".codex/skills/harness-requirements/SKILL.md"
    requirements_skill.parent.mkdir(parents=True)
    requirements_skill.write_text("# Requirements\n", encoding="utf-8")
    agent_config = tmp_path / ".codex/agents/requirements_interviewer.toml"
    agent_config.parent.mkdir(parents=True)
    agent_config.write_text(
        "\n".join(
            [
                'name = "requirements_interviewer"',
                'model = "gpt-5.4"',
                'sandbox_mode = "workspace-write"',
            ]
        ),
        encoding="utf-8",
    )

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
    assert captured["command"].index("--skip-git-repo-check") < captured["command"].index("--cd")


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


def test_event_storming_timeout_returns_actionable_error(tmp_path: Path, monkeypatch) -> None:
    agent_config = tmp_path / EVENT_STORMING_AGENT_CONFIG_PATH
    agent_config.parent.mkdir(parents=True)
    agent_config.write_text('name = "oracle"\n', encoding="utf-8")
    skill_path = tmp_path / EVENT_STORMING_SKILL_PATH
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Event Storming\n", encoding="utf-8")

    def time_out(*_args, **kwargs):
        raise subprocess.TimeoutExpired(["codex", "exec"], timeout=kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", time_out)

    with pytest.raises(
        ValueError,
        match="event storming timed out after 3600 seconds. Retry to continue from this use case.",
    ):
        _run_event_storming(
            tmp_path,
            {"event_storming": {"items": {"UC-001": {"clarifications": []}}}},
            "CHG-001",
            "UC-001",
        )

    assert EVENT_STORMING_TIMEOUT_SEC == 3600


def test_ddd_architecture_timeout_returns_actionable_error(tmp_path: Path, monkeypatch) -> None:
    agent_config = tmp_path / DDD_AGENT_CONFIG_PATH
    agent_config.parent.mkdir(parents=True)
    agent_config.write_text('name = "ddd_architect"\n', encoding="utf-8")
    skill_path = tmp_path / DDD_SKILL_PATH
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# DDD Design\n", encoding="utf-8")

    def time_out(*_args, **kwargs):
        raise subprocess.TimeoutExpired(["codex", "exec"], timeout=kwargs["timeout"])

    monkeypatch.setattr(subprocess, "run", time_out)

    with pytest.raises(
        ValueError,
        match="DDD architecture timed out after 3600 seconds. Retry to continue from this substep.",
    ):
        _run_ddd_architecture(
            tmp_path,
            {"ddd_architecture": {"items": {"UC-001": {"steps": {"entity_vo": {"clarifications": []}}}}}},
            "CHG-001",
            "UC-001",
            "entity_vo",
        )

    assert DDD_TIMEOUT_SEC == 3600
