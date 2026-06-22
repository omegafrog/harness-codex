from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

import harness_codex.runtime.change_set_completion_delivery as completion_delivery
import harness_codex.runtime.change_set_delivery as delivery


def _git(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=True,
    )


def _init_repository(repo_root: Path) -> None:
    _git(repo_root, "init", "-b", "main")
    _git(repo_root, "config", "user.name", "Harness Test")
    _git(repo_root, "config", "user.email", "harness@example.test")
    active = repo_root / "docs/changes/active/CHG-376.md"
    active.parent.mkdir(parents=True, exist_ok=True)
    active.write_text("# ChangeSet CHG-376\n", encoding="utf-8")
    _git(repo_root, "add", ".")
    _git(repo_root, "commit", "-m", "기본 상태")
    _git(repo_root, "remote", "add", "origin", "https://example.invalid/harness.git")


def _complete_active_change_set(repo_root: Path, _change_set, *, run_id: str) -> None:
    active = repo_root / "docs/changes/active/CHG-376.md"
    completed = repo_root / "docs/changes/completed/CHG-376.md"
    completed.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(active, completed)
    report = repo_root / ".harness/runs" / run_id / "changeset-completion-report.md"
    report.parent.mkdir(parents=True, exist_ok=True)
    report.write_text("완료\n", encoding="utf-8")


def _install_push_stub(monkeypatch, *, fail: bool) -> None:
    actual_run = delivery._run

    def fake_run(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
        if args[:2] == ("git", "push"):
            return subprocess.CompletedProcess(list(args), 1 if fail else 0, "", "push failed" if fail else "")
        return actual_run(repo_root, *args)

    monkeypatch.setattr(delivery, "_run", fake_run)
    monkeypatch.setattr(completion_delivery, "_run", fake_run)


def test_completion_push_failure_is_resumable_without_restaging_other_paths(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _init_repository(tmp_path)
    monkeypatch.setenv(delivery.DELIVERY_APPROVAL_ENV, "1")
    monkeypatch.setattr(completion_delivery, "complete_change_set_if_ready", _complete_active_change_set)
    _install_push_stub(monkeypatch, fail=True)

    with pytest.raises(delivery.DeliveryBlocked, match="push failed"):
        completion_delivery.complete_change_set_delivery(
            tmp_path,
            change_set_id="CHG-376",
            run_id="run-376",
        )

    assert not (tmp_path / "docs/changes/active/CHG-376.md").exists()
    assert (tmp_path / "docs/changes/completed/CHG-376.md").exists()
    assert _git(tmp_path, "show", "--format=", "--name-only", "HEAD").stdout.splitlines() == [
        "docs/changes/completed/CHG-376.md",
        "docs/changes/active/CHG-376.md",
    ]

    _install_push_stub(monkeypatch, fail=False)
    resumed = completion_delivery.complete_change_set_delivery(
        tmp_path,
        change_set_id="CHG-376",
        run_id="run-376",
    )

    assert resumed["already_completed"] is True
    assert resumed["committed_paths"] == ()


def test_completion_blocks_dirty_worktree_before_moving_changeset(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _init_repository(tmp_path)
    monkeypatch.setenv(delivery.DELIVERY_APPROVAL_ENV, "1")
    (tmp_path / "README.md").write_text("보존해야 하는 변경\n", encoding="utf-8")

    with pytest.raises(delivery.DeliveryBlocked, match="작업 트리"):
        completion_delivery.complete_change_set_delivery(
            tmp_path,
            change_set_id="CHG-376",
            run_id="run-376",
        )

    assert (tmp_path / "docs/changes/active/CHG-376.md").exists()
    assert not (tmp_path / "docs/changes/completed/CHG-376.md").exists()
    assert _git(tmp_path, "diff", "--cached", "--name-only").stdout == ""
