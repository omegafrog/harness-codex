import subprocess
from pathlib import Path

from harness_codex.runtime import changeset_orchestrator as orchestrator


def test_origin_main_start_point_pulls_clean_main(monkeypatch, tmp_path: Path) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_git(repo_root: Path, *args: str, check: bool = True):
        calls.append(args)
        if args == ("branch", "--show-current"):
            return subprocess.CompletedProcess(["git", *args], 0, "main\n", "")
        return subprocess.CompletedProcess(["git", *args], 0, "", "")

    monkeypatch.setattr(orchestrator, "_git", fake_git)

    assert orchestrator._origin_main_worktree_start_point(tmp_path) == "origin/main"
    assert ("fetch", "origin", "main") in calls
    assert ("pull", "--ff-only", "origin", "main") in calls


def test_origin_main_start_point_skips_pull_when_main_is_dirty(
    monkeypatch,
    tmp_path: Path,
) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_git(repo_root: Path, *args: str, check: bool = True):
        calls.append(args)
        if args == ("branch", "--show-current"):
            return subprocess.CompletedProcess(["git", *args], 0, "main\n", "")
        if args == ("status", "--porcelain=v1", "-z"):
            return subprocess.CompletedProcess(
                ["git", *args],
                0,
                " M docs/changes/active/CHG.md\0",
                "",
            )
        return subprocess.CompletedProcess(["git", *args], 0, "", "")

    monkeypatch.setattr(orchestrator, "_git", fake_git)

    assert orchestrator._origin_main_worktree_start_point(tmp_path) == "origin/main"
    assert ("fetch", "origin", "main") in calls
    assert ("pull", "--ff-only", "origin", "main") not in calls


def test_origin_main_start_point_falls_back_without_origin(
    monkeypatch,
    tmp_path: Path,
) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_git(repo_root: Path, *args: str, check: bool = True):
        calls.append(args)
        if args == ("remote", "get-url", "origin"):
            return subprocess.CompletedProcess(["git", *args], 2, "", "no origin")
        return subprocess.CompletedProcess(["git", *args], 0, "", "")

    monkeypatch.setattr(orchestrator, "_git", fake_git)

    assert orchestrator._origin_main_worktree_start_point(tmp_path) == "HEAD"
    assert ("fetch", "origin", "main") not in calls
