#!/usr/bin/env python3
"""현재 worktree를 건드리지 않고 ChangeSet worktree 하나를 만든다."""

import argparse
import json
import subprocess
from pathlib import Path


def git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args], text=True, capture_output=True, check=check
    )


def has_ref(root: Path, ref: str) -> bool:
    return git(root, "rev-parse", "--verify", "--quiet", ref, check=False).returncode == 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("changeset_id")
    args = parser.parse_args()
    changeset_id = args.changeset_id
    if not changeset_id.startswith("CHG-"):
        parser.error("changeset_id는 CHG-로 시작해야 합니다.")

    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").stdout.strip())
    branch = f"changes/{changeset_id}"
    target = root.parent / f"{root.name}-{changeset_id}"
    if target.exists():
        raise SystemExit(f"worktree 경로가 이미 있습니다: {target}")
    if has_ref(root, f"refs/heads/{branch}"):
        raise SystemExit(f"branch가 이미 있습니다: {branch}")

    git(root, "fetch", "origin", "main", check=False)
    base = "origin/main" if has_ref(root, "refs/remotes/origin/main") else "HEAD"
    git(root, "worktree", "add", "-b", branch, str(target), base)
    print(json.dumps({"branch": branch, "base": base, "worktree": str(target)}))


if __name__ == "__main__":
    main()
