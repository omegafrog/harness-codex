from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

import harness_codex.runtime.change_set_delivery as delivery
import harness_codex.runtime.change_set_pr_delivery as pr_delivery
from harness_codex.runtime.workflows import load_named_workflow


def _git(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=True,
    )


def _write_changeset(repo_root: Path) -> None:
    path = repo_root / "docs/changes/active/CHG-376.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            (
                "# ChangeSet CHG-376",
                "",
                "## 1. Metadata",
                "|Item|Value|",
                "|---|---|",
                "|ChangeSet ID|`CHG-376`|",
                "|Status|active|",
                "",
                "## 8. Scope Boundary",
                "### Included",
                "- `src/allowed/**`",
                "",
                "### Excluded",
                "- `src/unrelated/**`",
                "",
            )
        ),
        encoding="utf-8",
    )


def _init_repository(repo_root: Path) -> None:
    _git(repo_root, "init", "-b", "main")
    _git(repo_root, "config", "user.name", "Harness Test")
    _git(repo_root, "config", "user.email", "harness@example.test")
    (repo_root / "README.md").write_text("base\n", encoding="utf-8")
    source = repo_root / "src/allowed/service.py"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text("VALUE = 'base'\n", encoding="utf-8")
    _write_changeset(repo_root)
    _git(repo_root, "add", ".")
    _git(repo_root, "commit", "-m", "기본 상태")
    _git(repo_root, "checkout", "-b", "feature/chg-376")
    _git(repo_root, "remote", "add", "origin", "https://example.invalid/harness.git")


def _install_delivery_stubs(monkeypatch, *, push_returncode: int = 0):
    actual_run = delivery._run
    calls: list[tuple[str, ...]] = []

    def fake_run(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        if args[:2] == ("git", "push"):
            return subprocess.CompletedProcess(
                list(args),
                push_returncode,
                "",
                "push failed" if push_returncode else "",
            )
        if args[:3] == ("gh", "pr", "view"):
            return subprocess.CompletedProcess(list(args), 1, "", "no pull request")
        if args[:3] == ("gh", "pr", "create"):
            return subprocess.CompletedProcess(
                list(args),
                0,
                "https://github.com/example/harness/pull/376\n",
                "",
            )
        return actual_run(repo_root, *args)

    monkeypatch.setattr(delivery, "_run", fake_run)
    monkeypatch.setattr(pr_delivery, "_run", fake_run)
    monkeypatch.setattr(delivery.shutil, "which", lambda _binary: "/usr/bin/gh")
    monkeypatch.setenv(delivery.DELIVERY_APPROVAL_ENV, "1")
    return calls


def test_delivery_blocks_and_preserves_out_of_scope_dirty_changes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _init_repository(tmp_path)
    (tmp_path / "src/allowed/service.py").write_text("VALUE = 'changed'\n", encoding="utf-8")
    unrelated = tmp_path / "src/unrelated/notes.txt"
    unrelated.parent.mkdir(parents=True)
    unrelated.write_text("do not commit\n", encoding="utf-8")
    calls = _install_delivery_stubs(monkeypatch)

    with pytest.raises(delivery.DeliveryBlocked, match="범위 밖"):
        pr_delivery.create_change_set_pull_request(
            tmp_path,
            change_set_id="CHG-376",
            run_id="run-376",
        )

    assert _git(tmp_path, "diff", "--cached", "--name-only").stdout == ""
    assert unrelated.read_text(encoding="utf-8") == "do not commit\n"
    report = tmp_path / ".harness/runs/run-376/delivery-scope.json"
    assert "src/unrelated/notes.txt" in report.read_text(encoding="utf-8")
    assert not any(args[:3] == ("git", "add", "-A") for args in calls)


def test_delivery_commits_only_changeset_scope_with_pathspec_and_korean_pr_metadata(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _init_repository(tmp_path)
    (tmp_path / "src/allowed/service.py").write_text("VALUE = 'changed'\n", encoding="utf-8")
    calls = _install_delivery_stubs(monkeypatch)

    result = pr_delivery.create_change_set_pull_request(
        tmp_path,
        change_set_id="CHG-376",
        run_id="run-376",
    )

    committed_paths = _git(tmp_path, "show", "--format=", "--name-only", "HEAD").stdout.splitlines()
    assert committed_paths == ["src/allowed/service.py"]
    assert result.committed_paths == ("src/allowed/service.py",)
    assert result.pull_request == "https://github.com/example/harness/pull/376"
    assert ("git", "add", "--", "src/allowed/service.py") in calls
    create_args = next(args for args in calls if args[:3] == ("gh", "pr", "create"))
    assert "CHG-376 변경 세트 전달" in create_args
    assert any("ChangeSet 범위로 승인된 경로만" in value for value in create_args)
    assert not any(args[:3] == ("git", "add", "-A") for args in calls)


def test_delivery_requires_explicit_approval_before_git_mutation(tmp_path: Path) -> None:
    _init_repository(tmp_path)
    (tmp_path / "src/allowed/service.py").write_text("VALUE = 'changed'\n", encoding="utf-8")

    with pytest.raises(delivery.DeliveryBlocked, match="approval|승인"):
        pr_delivery.create_change_set_pull_request(
            tmp_path,
            change_set_id="CHG-376",
            run_id="run-376",
        )

    assert _git(tmp_path, "diff", "--cached", "--name-only").stdout == ""


def test_push_failure_keeps_changeset_active_for_resume(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _init_repository(tmp_path)
    (tmp_path / "src/allowed/service.py").write_text("VALUE = 'changed'\n", encoding="utf-8")
    _install_delivery_stubs(monkeypatch, push_returncode=1)

    with pytest.raises(delivery.DeliveryBlocked, match="push failed"):
        pr_delivery.create_change_set_pull_request(
            tmp_path,
            change_set_id="CHG-376",
            run_id="run-376",
        )

    assert (tmp_path / "docs/changes/active/CHG-376.md").exists()
    assert not (tmp_path / "docs/changes/completed/CHG-376.md").exists()


def test_canonical_workflow_uses_explicit_scope_safe_delivery_commands() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )

    pull_request = workflow.step_by_id("create-change-set-pr")
    completion = workflow.step_by_id("complete-change-set")

    assert pull_request.command == (
        "python3 -m harness_codex.runtime.change_set_pr_delivery "
        "--change-set <CHG-ID> --run-id <RUN-ID>"
    )
    assert completion.command == (
        "python3 -m harness_codex.runtime.change_set_completion_delivery "
        "--change-set <CHG-ID> --run-id <RUN-ID>"
    )
    assert pull_request.metadata["approval_env"] == delivery.DELIVERY_APPROVAL_ENV
    assert completion.metadata["approval_env"] == delivery.DELIVERY_APPROVAL_ENV
