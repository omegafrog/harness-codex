from __future__ import annotations

from pathlib import Path

from harness_codex import canonical_cli
def test_public_orchestrate_command_never_creates_a_parent_agent(tmp_path: Path, capsys) -> None:
    assert canonical_cli.main(["--repo-root", str(tmp_path), "orchestrate", "사용자", "요청"]) == 2
    assert "별도 orchestration agent를 생성하지 않습니다" in capsys.readouterr().err


def test_public_orchestrate_command_requires_prompt(tmp_path: Path, capsys) -> None:
    assert canonical_cli.main(["--repo-root", str(tmp_path), "orchestrate"]) == 2
    assert "requires a user prompt" in capsys.readouterr().err


def test_legacy_stage_command_is_rejected(tmp_path: Path, capsys) -> None:
    assert canonical_cli.main(["--repo-root", str(tmp_path), "plan-writing"]) == 2
    assert "legacy direct stage command removed: plan-writing" in capsys.readouterr().err
