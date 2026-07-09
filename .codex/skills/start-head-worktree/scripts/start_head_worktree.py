#!/usr/bin/env python3

import argparse
import re
import subprocess
import sys
from pathlib import Path


def git(repo: Path, *args: str, check: bool = True) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if check and result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise RuntimeError(message)
    return result.stdout.strip()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    if not slug:
        raise ValueError("task slug must contain at least one letter or digit")
    return slug[:48].rstrip("-")


def branch_exists(repo: Path, branch: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo), "show-ref", "--verify", "--quiet", f"refs/heads/{branch}"],
        check=False,
    )
    return result.returncode == 0


def choose_generated_targets(repo: Path, slug: str) -> tuple[str, Path]:
    parent = repo.parent
    stem = f"{repo.name}-{slug}"
    for index in range(1, 10_000):
        suffix = "" if index == 1 else f"-{index}"
        branch = f"worktree/{slug}{suffix}"
        path = parent / f"{stem}{suffix}"
        if not branch_exists(repo, branch) and not path.exists():
            return branch, path
    raise RuntimeError("could not find available generated branch and path")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create an isolated Git worktree from exact current HEAD."
    )
    parser.add_argument("task_slug")
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--branch")
    parser.add_argument("--path", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        repo = Path(git(args.repo.resolve(), "rev-parse", "--show-toplevel"))
        if git(repo, "status", "--porcelain"):
            raise RuntimeError("source worktree must be clean before fetch and pull")
        branch_name = git(repo, "symbolic-ref", "--quiet", "--short", "HEAD")
        git(repo, "fetch", "origin")
        git(repo, "pull", "--ff-only", "origin", branch_name)
        head = git(repo, "rev-parse", "HEAD")
        slug = slugify(args.task_slug)

        if args.branch is None and args.path is None:
            branch, worktree_path = choose_generated_targets(repo, slug)
        else:
            branch = args.branch or f"worktree/{slug}"
            worktree_path = (
                args.path.expanduser().resolve()
                if args.path
                else repo.parent / f"{repo.name}-{slug}"
            )
            if branch_exists(repo, branch):
                raise RuntimeError(f"branch already exists: {branch}")
            if worktree_path.exists():
                raise RuntimeError(f"path already exists: {worktree_path}")

        worktree_path.parent.mkdir(parents=True, exist_ok=True)
        git(repo, "worktree", "add", "-b", branch, str(worktree_path), head)

        print(f"path={worktree_path}")
        print(f"branch={branch}")
        print(f"base={head}")
        print(f"source_branch={branch_name}")
        print("source_updated=true")
        return 0
    except (OSError, RuntimeError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
