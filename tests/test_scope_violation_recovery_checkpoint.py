import subprocess
from pathlib import Path

from harness_codex.runtime.scope_violation_recovery_patch import _checkpoint_candidate_paths
from harness_codex.runtime.agent_write_scope_policy_patch import _capture_worktree_snapshot


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, text=True, capture_output=True)


def test_checkpoint_candidates_exclude_ignored_runtime_outputs(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "tester")
    _git(tmp_path, "config", "user.email", "tester@example.com")
    (tmp_path / ".gitignore").write_text(".harness/runs/\nbuild/\n", encoding="utf-8")
    (tmp_path / "tracked.txt").write_text("before\n", encoding="utf-8")
    _git(tmp_path, "add", ".gitignore", "tracked.txt")
    _git(tmp_path, "commit", "-m", "초기 커밋")

    (tmp_path / "tracked.txt").write_text("after\n", encoding="utf-8")
    (tmp_path / "untracked.txt").write_text("new\n", encoding="utf-8")
    ignored_run = tmp_path / ".harness/runs/run-1/state.json"
    ignored_run.parent.mkdir(parents=True)
    ignored_run.write_text("{}\n", encoding="utf-8")
    ignored_build = tmp_path / "build/classes/generated.bin"
    ignored_build.parent.mkdir(parents=True)
    ignored_build.write_bytes(b"generated")

    candidates = _checkpoint_candidate_paths(tmp_path)

    assert "tracked.txt" in candidates
    assert "untracked.txt" in candidates
    assert ".harness/runs/run-1/state.json" not in candidates
    assert "build/classes/generated.bin" not in candidates


def test_scope_snapshot_excludes_ignored_runtime_outputs(tmp_path: Path) -> None:
    _git(tmp_path, "init")
    _git(tmp_path, "config", "user.name", "tester")
    _git(tmp_path, "config", "user.email", "tester@example.com")
    (tmp_path / ".gitignore").write_text(".harness/runs/\nbuild/\n", encoding="utf-8")
    (tmp_path / "tracked.txt").write_text("before\n", encoding="utf-8")
    _git(tmp_path, "add", ".gitignore", "tracked.txt")
    _git(tmp_path, "commit", "-m", "초기 커밋")

    (tmp_path / "tracked.txt").write_text("after\n", encoding="utf-8")
    ignored_run = tmp_path / ".harness/runs/run-1/state.json"
    ignored_run.parent.mkdir(parents=True)
    ignored_run.write_text("{}\n", encoding="utf-8")
    ignored_build = tmp_path / "build/classes/generated.bin"
    ignored_build.parent.mkdir(parents=True)
    ignored_build.write_bytes(b"generated")

    snapshot = _capture_worktree_snapshot(tmp_path)

    assert "tracked.txt" in snapshot
    assert ".harness/runs/run-1/state.json" not in snapshot
    assert "build/classes/generated.bin" not in snapshot
