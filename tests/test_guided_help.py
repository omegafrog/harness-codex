from __future__ import annotations

from pathlib import Path

from harness_codex import canonical_cli
from harness_codex import cli as stage_runtime


ACTIVE_CHANGESET = """# ChangeSet CHG-001

## 1. 메타데이터
|항목|값|
|---|---|
|ChangeSet ID|`CHG-001`|
|상태|active|
|제목|Guided help|

## 3. Before / After
|구분|내용|
|---|---|
|Before|static command index|
|After|guided workflow help|

## 5. 영향 유스케이스
|UC ID|유스케이스 이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`UC-001`|Help 안내|update|`docs/use-cases/UC-001/`|planned|
"""


def _write_active_changeset(repo_root: Path, change_set_id: str = "CHG-001") -> None:
    active_dir = repo_root / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / f"{change_set_id}.md").write_text(
        ACTIVE_CHANGESET.replace("CHG-001", change_set_id),
        encoding="utf-8",
    )


def test_help_guides_new_workspace_without_runtime_side_effects(tmp_path: Path, monkeypatch, capsys) -> None:
    def fail_stage_runtime(_arguments: list[str]) -> int:
        raise AssertionError("help must not delegate to the mutating stage runtime")

    monkeypatch.setattr(canonical_cli._stage_runtime, "main", fail_stage_runtime)

    assert canonical_cli.main(["--repo-root", str(tmp_path), "help"]) == 0

    output = capsys.readouterr().out
    assert "Start a ChangeSet:" in output
    assert "requirements-definition --title" in output
    assert list(tmp_path.iterdir()) == []


def test_help_guides_single_active_changeset_to_safe_plan(tmp_path: Path, capsys) -> None:
    _write_active_changeset(tmp_path)

    assert canonical_cli.main(["--repo-root", str(tmp_path), "help"]) == 0

    output = capsys.readouterr().out
    assert "Continue CHG-001" in output
    assert "harness changes continue CHG-001 --plan" in output
    assert "harness changes continue CHG-001 --apply" in output


def test_help_supports_nested_changes_continue_topic(capsys) -> None:
    assert canonical_cli.main(["help", "changes", "continue"]) == 0

    output = capsys.readouterr().out
    assert "Usage: harness changes continue CHG-ID" in output
    assert "--blocker-resolution requirements|use-case" in output
    assert "--plan before --apply" in output


def test_public_catalog_excludes_retired_commands_and_matches_stage_boundary() -> None:
    expected = {
        command
        for command, _summary in stage_runtime.COMMAND_HELP
        if command not in {"ultrawork", "change-set-pr"}
    }

    assert canonical_cli.PUBLIC_COMMANDS == expected
    assert "ultrawork" not in canonical_cli.TOPIC_HELP
    assert "change-set-pr" not in canonical_cli.TOPIC_HELP
