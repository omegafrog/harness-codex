#!/usr/bin/env python3
"""현재 worktree를 건드리지 않고 ChangeSet worktree 하나를 만든다."""

import argparse
import json
import shutil
import subprocess
from pathlib import Path


LOCAL_HARNESS_PATHS = (".codex", "harness", "harness_codex", "completions")
TOKEN_BASIS = Path(".codex/workflow/token-estimation.md")


def git(root: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(root), *args], text=True, capture_output=True, check=check
    )


def has_ref(root: Path, ref: str) -> bool:
    return git(root, "rev-parse", "--verify", "--quiet", ref, check=False).returncode == 0


def copy_local_harness(root: Path, target: Path) -> list[str]:
    copied: list[str] = []
    for relative in LOCAL_HARNESS_PATHS:
        source = root / relative
        destination = target / relative
        if source.is_dir():
            shutil.copytree(source, destination, dirs_exist_ok=True, symlinks=True)
        else:
            shutil.copy2(source, destination, follow_symlinks=False)
        copied.append(relative)
    return copied


def state_path(root: Path, changeset_id: str) -> Path:
    return root / ".harness/state/changesets" / changeset_id / "workspace.json"


def read_resumable_state(root: Path, changeset_id: str) -> dict[str, object] | None:
    path = state_path(root, changeset_id)
    if not path.is_file():
        return None
    state = json.loads(path.read_text(encoding="utf-8"))
    worktree = Path(str(state.get("worktree", "")))
    if state.get("changeset_id") != changeset_id or not worktree.is_dir():
        raise SystemExit(f"재개할 ChangeSet 상태가 유효하지 않습니다: {path}")
    if not (worktree / TOKEN_BASIS).is_file():
        raise SystemExit(f"token 추정 기준 파일이 없습니다: {worktree / TOKEN_BASIS}")
    return state


def write_state(root: Path, state: dict[str, object]) -> Path:
    path = state_path(root, str(state["changeset_id"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("changeset_id")
    args = parser.parse_args()
    changeset_id = args.changeset_id
    if not changeset_id.startswith("CHG-"):
        parser.error("changeset_id는 CHG-로 시작해야 합니다.")

    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel").stdout.strip())
    resumed = read_resumable_state(root, changeset_id)
    if resumed is not None:
        resumed["resumed"] = True
        print(json.dumps(resumed, ensure_ascii=False))
        return
    missing = [path for path in LOCAL_HARNESS_PATHS if not (root / path).exists()]
    if missing:
        raise SystemExit(f"로컬 harness 설치 파일이 없습니다: {', '.join(missing)}")
    branch = f"changes/{changeset_id}"
    target = root.parent / f"{root.name}-{changeset_id}"
    if target.exists():
        raise SystemExit(f"worktree 경로가 이미 있습니다: {target}")
    if has_ref(root, f"refs/heads/{branch}"):
        raise SystemExit(f"branch가 이미 있습니다: {branch}")

    git(root, "fetch", "origin", "main", check=False)
    base = "origin/main" if has_ref(root, "refs/remotes/origin/main") else "HEAD"
    git(root, "worktree", "add", "-b", branch, str(target), base)
    try:
        copied = copy_local_harness(root, target)
        token_basis = target / TOKEN_BASIS
        if not token_basis.is_file():
            raise RuntimeError(f"token 추정 기준 파일이 없습니다: {token_basis}")
        state = {
            "changeset_id": changeset_id,
            "status": "active",
            "branch": branch,
            "base": base,
            "worktree": str(target),
            "token_estimation_basis": str(token_basis),
            "copied": copied,
            "resumed": False,
        }
        state["state_file"] = str(state_path(root, changeset_id))
        state_file = write_state(root, state)
    except Exception:
        git(root, "worktree", "remove", "--force", str(target), check=False)
        raise
    print(json.dumps(state, ensure_ascii=False))


if __name__ == "__main__":
    main()
