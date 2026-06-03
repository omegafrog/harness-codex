from pathlib import Path

from harness_codex.runtime.shell_completion import (
    change_set_candidates,
    format_candidates,
    install_completion,
    run_change_candidates,
)


CHANGESET_A = """# Add note analysis

## 1. Metadata

| Item | Value |
|---|---|
| ChangeSet ID | `CHG-20260522-001` |
| Status | active |

## 2. Implementation Intent

- Request summary: Add note analysis.

## 3. Before / After

| Before | After |
|---|---|
| Before A | After A |
"""

CHANGESET_B = """# Improve runtime completion

## 1. Metadata

| Item | Value |
|---|---|
| ChangeSet ID | `CHG-20260522-002` |
| Status | active |

## 2. Implementation Intent

- Request summary: Improve completion.

## 3. Before / After

| Before | After |
|---|---|
| Before B | After B |
"""


def test_run_change_candidates_returns_active_changeset_ids_and_titles(tmp_path: Path):
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-20260522-001.md").write_text(CHANGESET_A, encoding="utf-8")
    (active_dir / "CHG-20260522-002.md").write_text(CHANGESET_B, encoding="utf-8")

    candidates = run_change_candidates(tmp_path)

    assert [(item.value, item.description) for item in candidates] == [
        ("CHG-20260522-001", "active - Add note analysis"),
        ("CHG-20260522-002", "active - Improve runtime completion"),
    ]


def test_run_change_candidates_filters_by_prefix(tmp_path: Path):
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-20260522-001.md").write_text(CHANGESET_A, encoding="utf-8")
    (active_dir / "CHG-20260522-002.md").write_text(CHANGESET_B, encoding="utf-8")

    candidates = run_change_candidates(tmp_path, "CHG-20260522-002")

    assert [(item.value, item.description) for item in candidates] == [
        ("CHG-20260522-002", "active - Improve runtime completion"),
    ]


def test_run_change_candidates_returns_empty_when_no_active_changesets(tmp_path: Path):
    assert run_change_candidates(tmp_path) == ()


def test_format_candidates_supports_bash_zsh_and_tsv(tmp_path: Path):
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-20260522-001.md").write_text(CHANGESET_A, encoding="utf-8")
    candidates = run_change_candidates(tmp_path)

    assert format_candidates(candidates, shell_format="bash") == "CHG-20260522-001"
    assert (
        format_candidates(candidates, shell_format="zsh")
        == "CHG-20260522-001:active - Add note analysis"
    )
    assert (
        format_candidates(candidates, shell_format="tsv")
        == "CHG-20260522-001\tactive - Add note analysis"
    )


def test_change_set_candidates_include_completed_status_and_title(tmp_path: Path):
    active_dir = tmp_path / "docs/changes/active"
    completed_dir = tmp_path / "docs/changes/completed"
    active_dir.mkdir(parents=True)
    completed_dir.mkdir(parents=True)
    (active_dir / "CHG-20260522-001.md").write_text(CHANGESET_A, encoding="utf-8")
    (completed_dir / "CHG-20260522-002.md").write_text(
        CHANGESET_B.replace("| Status | active |", "| Status | completed |"),
        encoding="utf-8",
    )

    candidates = change_set_candidates(tmp_path, scope="all")

    assert [(item.value, item.description) for item in candidates] == [
        ("CHG-20260522-001", "active - Add note analysis"),
        ("CHG-20260522-002", "completed - Improve runtime completion"),
    ]


def test_install_completion_copies_zsh_completion(tmp_path: Path):
    repo = tmp_path / "repo"
    source_dir = repo / "completions"
    source_dir.mkdir(parents=True)
    (source_dir / "_harness").write_text("# zsh completion\n", encoding="utf-8")
    home = tmp_path / "home"

    result = install_completion(repo, shell="zsh", home=home)

    target = home / ".zfunc/_harness"
    assert target.read_text(encoding="utf-8") == "# zsh completion\n"
    assert result[0].shell == "zsh"
    assert result[0].target == target


def test_install_completion_copies_bash_completion(tmp_path: Path):
    repo = tmp_path / "repo"
    source_dir = repo / "completions"
    source_dir.mkdir(parents=True)
    (source_dir / "harness.bash").write_text("# bash completion\n", encoding="utf-8")
    home = tmp_path / "home"

    result = install_completion(repo, shell="bash", home=home)

    target = home / ".local/share/bash-completion/completions/harness"
    assert target.read_text(encoding="utf-8") == "# bash completion\n"
    assert result[0].shell == "bash"
    assert result[0].target == target
