import json
import subprocess
from pathlib import Path

from harness_codex.runtime.scope_violation_recovery_patch import (
    _preexisting_dirty_paths,
    capture_git_recovery_checkpoint,
    recover_scope_violation,
)


def _git(repo_root: Path, *arguments: str) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=True,
    )
    return completed.stdout


def test_scope_recovery_uses_git_checkpoints_for_dirty_and_ignored_files(
    tmp_path: Path,
) -> None:
    _git(tmp_path, "init")
    (tmp_path / ".gitignore").write_text("*.ignored\n", encoding="utf-8")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("base\n", encoding="utf-8")
    _git(tmp_path, "add", ".gitignore", "tracked.txt")

    tracked.write_text("staged-before-agent\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    tracked.write_text("dirty-before-agent\n", encoding="utf-8")
    existing_ignored = tmp_path / "existing.ignored"
    existing_ignored.write_text("keep-before-agent\n", encoding="utf-8")

    preexisting_dirty_files = _preexisting_dirty_paths(tmp_path)
    checkpoint = capture_git_recovery_checkpoint(tmp_path)

    tracked.write_text("agent-change\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    existing_ignored.write_text("agent-overwrite\n", encoding="utf-8")
    new_ignored = tmp_path / "new.ignored"
    new_ignored.write_text("agent-created\n", encoding="utf-8")

    step_dir = tmp_path / ".harness/runs/run-001/steps/agent"
    scope_report = step_dir / "scope-diff-report.json"
    step_dir.mkdir(parents=True)
    scope_report.write_text("{}\n", encoding="utf-8")

    recovery = recover_scope_violation(
        repo_root=tmp_path,
        step_dir=step_dir,
        scope_report_path=scope_report,
        checkpoint=checkpoint,
        preexisting_dirty_files=preexisting_dirty_files,
        blocked_files=("tracked.txt", "existing.ignored", "new.ignored"),
    )

    assert tracked.read_text(encoding="utf-8") == "dirty-before-agent\n"
    assert _git(tmp_path, "show", ":tracked.txt") == "staged-before-agent\n"
    assert existing_ignored.read_text(encoding="utf-8") == "keep-before-agent\n"
    assert not new_ignored.exists()
    assert set(recovery.recovered_files) == {
        "tracked.txt",
        "existing.ignored",
        "new.ignored",
    }
    assert set(recovery.preserved_preexisting_dirty_files) == {
        "tracked.txt",
        "existing.ignored",
    }

    report = json.loads(recovery.report_path.read_text(encoding="utf-8"))
    assert report["checkpoint"]["index_commit"] == checkpoint.index_commit
    assert report["checkpoint"]["worktree_commit"] == checkpoint.worktree_commit
