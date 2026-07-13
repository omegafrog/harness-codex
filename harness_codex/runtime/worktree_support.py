"""Low-level Git and filesystem support for isolated ChangeSet worktrees."""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path
from uuid import uuid4


def git(repo_root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    completed = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if check and completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise RuntimeError(f"git {' '.join(args)} failed: {detail}")
    return completed


def safe_ref_part(value: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())
    normalized = normalized.strip(".-/")
    return normalized or "item"


def worktrees_base_dir(repo_root: Path, safe_change: str, safe_run: str) -> Path:
    legacy = repo_root / ".-harness-worktrees" / safe_change / safe_run
    if legacy.exists():
        return legacy
    return repo_root.parent / f".{repo_root.name}-harness-worktrees" / safe_change / safe_run


def absolute_repo_path(repo_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else (repo_root / path).resolve()


def is_git_worktree(repo_root: Path) -> bool:
    checked = git(repo_root, "rev-parse", "--is-inside-work-tree", check=False)
    return checked.returncode == 0 and checked.stdout.strip() == "true"


def usable_worktree(repo_root: Path, branch: str) -> bool:
    if not repo_root.exists() or not is_git_worktree(repo_root):
        return False
    current = git(repo_root, "branch", "--show-current", check=False)
    return current.returncode == 0 and current.stdout.strip() == branch


def worktree_dirty(repo_root: Path) -> bool:
    status = git(repo_root, "status", "--porcelain=v1", "-z", check=False)
    return status.returncode != 0 or bool(status.stdout)


def branch_contains(repo_root: Path, branch: str, required_ref: str) -> bool:
    checked = git(
        repo_root,
        "merge-base",
        "--is-ancestor",
        required_ref,
        branch,
        check=False,
    )
    return checked.returncode == 0


def add_worktree(repo_root: Path, path: Path, branch: str, start_point: str) -> None:
    absolute = absolute_repo_path(repo_root, path)
    if absolute.exists():
        remove_worktree(repo_root, absolute)
    absolute.parent.mkdir(parents=True, exist_ok=True)
    git(repo_root, "worktree", "add", "-B", branch, str(absolute), start_point)


def remove_worktree(repo_root: Path, path: Path) -> None:
    absolute = absolute_repo_path(repo_root, path)
    git(repo_root, "worktree", "remove", "--force", str(absolute), check=False)
    git(repo_root, "worktree", "prune", check=False)
    if absolute.is_symlink() or absolute.is_file():
        absolute.unlink(missing_ok=True)
    elif absolute.exists():
        shutil.rmtree(absolute, ignore_errors=True)
    if absolute.exists():
        absolute.rename(absolute.with_name(f".stale-{absolute.name}-{uuid4().hex[:8]}"))


def hydrate_runtime_worktree(
    source_root: Path,
    target_root: Path,
    *,
    copy_project_docs: bool,
) -> None:
    ensure_runs_link(source_root, target_root)
    for relative in (
        Path("harness"),
        Path("harness_codex"),
        Path(".codex/agents"),
        Path(".codex/skills"),
        Path(".harness/workflows"),
    ):
        mirror_path(source_root / relative, target_root / relative, symlink=True)
    if not copy_project_docs:
        return
    for relative in (
        Path("docs/changes"),
        Path("docs/use-cases"),
        Path("docs/plans"),
        Path("docs/design"),
        Path(".codex/repository-settings.md"),
        Path("AGENTS.md"),
        Path("ARCHITECTURE.md"),
        Path("context.md"),
    ):
        mirror_path(source_root / relative, target_root / relative, symlink=False)


def ensure_runs_link(source_root: Path, target_root: Path) -> None:
    source_runs = source_root / ".harness/runs"
    source_runs.mkdir(parents=True, exist_ok=True)
    harness_dir = target_root / ".harness"
    harness_dir.mkdir(parents=True, exist_ok=True)
    target_runs = harness_dir / "runs"
    if target_runs.is_symlink():
        target_runs.unlink()
    elif target_runs.exists():
        if target_runs.is_dir():
            shutil.rmtree(target_runs)
        else:
            target_runs.unlink()
    target_runs.symlink_to(source_runs.resolve(), target_is_directory=True)


def mirror_path(source: Path, target: Path, *, symlink: bool) -> None:
    if not source.exists():
        return
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.exists() and symlink:
        shutil.rmtree(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    if symlink:
        target.symlink_to(source.resolve(), target_is_directory=source.is_dir())
    elif source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True)
    else:
        shutil.copy2(source, target)


def remove_runtime_links(repo_root: Path) -> None:
    for relative in (
        Path(".harness/runs"),
        Path(".harness/workflows"),
        Path(".codex/agents"),
        Path(".codex/skills"),
        Path("harness"),
        Path("harness_codex"),
    ):
        target = repo_root / relative
        if target.is_symlink():
            target.unlink()


def committable_status_paths(status_text: str) -> tuple[str, ...]:
    """Return paths safe to stage from porcelain-v1 ``-z`` output.

    Git emits a rename or copy destination in the status record, followed by a
    second NUL-delimited source path. Only the destination belongs in `git add`.
    """

    excluded = (
        ".harness/runs",
        ".harness/workflows",
        ".codex/agents",
        ".codex/skills",
        "harness",
        "harness_codex",
        "venv",
    )
    paths: list[str] = []
    entries = [entry for entry in status_text.split("\0") if entry]
    skip_rename_source = False
    for entry in entries:
        if skip_rename_source:
            skip_rename_source = False
            continue
        if len(entry) < 4:
            continue
        status = entry[:2]
        path = entry[3:]
        if status[0] in {"R", "C"} or status[1] in {"R", "C"}:
            skip_rename_source = True
        if not path or any(path == prefix or path.startswith(prefix + "/") for prefix in excluded):
            continue
        paths.append(path)
    return tuple(dict.fromkeys(paths))
