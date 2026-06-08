import shutil
import subprocess
from pathlib import Path

from harness_codex.runtime.shell_completion import (
    change_set_candidates,
    format_candidates,
    install_completion,
    main,
    run_id_candidates,
    stage_candidates,
    use_case_candidates,
    use_case_directory_candidates,
    work_item_candidates,
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

## 5. Affected Use Cases

| UC ID | Use Case Name | Impact Type | Slice Path | Status |
|---|---|---|---|---|
| `UC-001` | Payment approval | update | `docs/use-cases/UC-001/` | planned |
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


def test_change_set_candidates_returns_active_changeset_ids_and_titles(tmp_path: Path):
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-20260522-001.md").write_text(CHANGESET_A, encoding="utf-8")
    (active_dir / "CHG-20260522-002.md").write_text(CHANGESET_B, encoding="utf-8")

    candidates = change_set_candidates(tmp_path)

    assert [(item.value, item.description) for item in candidates] == [
        ("CHG-20260522-001", "active - Add note analysis (CHG-20260522-001)"),
        (
            "CHG-20260522-002",
            "active - Improve runtime completion (CHG-20260522-002)",
        ),
    ]


def test_change_set_candidates_filters_by_prefix(tmp_path: Path):
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-20260522-001.md").write_text(CHANGESET_A, encoding="utf-8")
    (active_dir / "CHG-20260522-002.md").write_text(CHANGESET_B, encoding="utf-8")

    candidates = change_set_candidates(tmp_path, "CHG-20260522-002")

    assert [(item.value, item.description) for item in candidates] == [
        (
            "CHG-20260522-002",
            "active - Improve runtime completion (CHG-20260522-002)",
        ),
    ]


def test_change_set_candidates_returns_empty_when_no_active_changesets(tmp_path: Path):
    assert change_set_candidates(tmp_path) == ()


def test_format_candidates_supports_bash_zsh_and_tsv(tmp_path: Path):
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-20260522-001.md").write_text(CHANGESET_A, encoding="utf-8")
    candidates = change_set_candidates(tmp_path)

    assert format_candidates(candidates, shell_format="bash") == "CHG-20260522-001"
    assert (
        format_candidates(candidates, shell_format="zsh")
        == "CHG-20260522-001:active - Add note analysis (CHG-20260522-001)"
    )
    assert (
        format_candidates(candidates, shell_format="tsv")
        == "CHG-20260522-001\tactive - Add note analysis (CHG-20260522-001)"
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
        ("CHG-20260522-001", "active - Add note analysis (CHG-20260522-001)"),
        (
            "CHG-20260522-002",
            "completed - Improve runtime completion (CHG-20260522-002)",
        ),
    ]


def test_use_case_and_work_item_candidates_read_changeset_items(tmp_path: Path):
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-20260522-001.md").write_text(CHANGESET_A, encoding="utf-8")

    assert [(item.value, item.description) for item in use_case_candidates(tmp_path, "CHG-20260522-001")] == [
        ("UC-001", "Payment approval")
    ]
    assert [(item.value, item.description) for item in work_item_candidates(tmp_path, "CHG-20260522-001")] == [
        ("UC-001", "Payment approval")
    ]


def test_directory_run_and_stage_candidates(tmp_path: Path):
    (tmp_path / "docs/use-cases/UC-001").mkdir(parents=True)
    (tmp_path / ".harness/runs/run-001").mkdir(parents=True)
    (tmp_path / ".harness/stages/CHG-001").mkdir(parents=True)
    (tmp_path / ".harness/stages/CHG-001/custom-stage.md").write_text("# Stage\n", encoding="utf-8")

    assert [item.value for item in use_case_directory_candidates(tmp_path)] == ["UC-001"]
    assert [item.value for item in run_id_candidates(tmp_path)] == ["run-001"]
    assert "custom-stage" in [item.value for item in stage_candidates(tmp_path, "CHG-001")]
    assert "requirements-definition" in [item.value for item in stage_candidates(tmp_path, "CHG-001")]


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


def test_bash_completion_lists_supported_runtime_commands_only():
    text = Path("completions/harness.bash").read_text(encoding="utf-8")

    assert "help init update reset agent-context changes contracts completion" in text
    assert "--repo --ref --skip-venv --dry-run" in text
    assert "completion" in text
    assert "--shell" in text


def test_zsh_completion_lists_delete_and_reset_commands():
    text = Path("completions/_harness").read_text(encoding="utf-8")

    assert "'help:Show runtime help'" in text
    assert "'reset:Reset local runtime artifacts'" in text
    assert "'completion:Install shell completion'" in text
    assert "'delete:Delete one active ChangeSet'" in text
    assert "'update:Update installed runtime files'" in text
    assert "--shell" in text


def test_zsh_completion_uses_named_describe_arrays():
    if shutil.which("zsh") is None:
        return

    script = """
source completions/_harness
_describe() {
  local label="$1"
  local array_name="$2"
  print -- "${label}:${(P)array_name[*]}"
}
words=(harness completion "")
CURRENT=3
PREFIX=""
_harness
words=(harness "")
CURRENT=2
PREFIX=""
_harness
words=(harness use-case-definition CHG-001 --)
CURRENT=4
PREFIX="--"
_harness
words=(harness changes continue CHG-001 --)
CURRENT=5
PREFIX="--"
_harness
"""

    result = subprocess.run(
        ["zsh", "-fc", script],
        check=False,
        text=True,
        capture_output=True,
    )

    assert result.returncode == 0, result.stderr
    assert "completion command:install:Install shell completion" in result.stdout
    assert "command:help:Show runtime help" in result.stdout
    assert "option:--uc:use case id" in result.stdout
    assert "--apply:run and apply side effects" in result.stdout
    assert "option:--uc:use case id --plan:show execution plan without side effects --preview:show preview without side effects --apply:run and apply side effects" in result.stdout
    assert "--apply[run and apply side effects]" not in result.stdout


def test_shell_completion_cli_change_set_parser_accepts_scope(tmp_path: Path, capsys):
    (tmp_path / "docs/changes/active").mkdir(parents=True)
    (tmp_path / "docs/changes/active/CHG-001.md").write_text(CHANGESET_A, encoding="utf-8")

    exit_code = main(["change-set", "--repo-root", str(tmp_path), "--scope", "active", "--format", "bash"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "CHG-20260522-001" in output
