#!/usr/bin/env python3
"""현재 worktree를 건드리지 않고 ChangeSet worktree 하나를 만든다."""

import argparse
import json
import shutil
import subprocess
from pathlib import Path


LOCAL_HARNESS_PATHS = (".codex", "harness", "harness_codex", "completions")
TOKEN_BASIS = Path(".codex/workflow/token-estimation.md")
CHANGESET_TEMPLATE = Path(".codex/workflow/changeset-template.md")


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


def changeset_document_path(worktree: Path, changeset_id: str) -> Path:
    return worktree / "docs/changes/active" / changeset_id / "changeset.md"


def create_changeset_skeleton(worktree: Path, changeset_id: str) -> Path:
    template = worktree / CHANGESET_TEMPLATE
    if not template.is_file():
        raise RuntimeError(f"ChangeSet template이 없습니다: {template}")
    document = changeset_document_path(worktree, changeset_id)
    if document.exists():
        if f"id: {changeset_id}" not in document.read_text(encoding="utf-8"):
            raise RuntimeError(f"다른 ChangeSet 문서가 있습니다: {document}")
        return document
    document.parent.mkdir(parents=True, exist_ok=True)
    document.write_text(
        template.read_text(encoding="utf-8").replace("<CHG-ID>", changeset_id),
        encoding="utf-8",
    )
    return document


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
    document = Path(str(state.get("changeset_document", "")))
    if document != changeset_document_path(worktree, changeset_id) or not document.is_file():
        raise SystemExit(f"ChangeSet 문서가 없습니다: {document}")
    return state


def write_state(root: Path, state: dict[str, object]) -> Path:
    path = state_path(root, str(state["changeset_id"]))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path


def current_branch(worktree: Path) -> str:
    return git(worktree, "branch", "--show-current", check=False).stdout.strip()


def recover_existing_worktree(
    root: Path, changeset_id: str, branch: str, target: Path
) -> dict[str, object]:
    if current_branch(target) != branch:
        raise SystemExit(f"기존 worktree branch가 일치하지 않습니다: {target}")
    copied = copy_local_harness(root, target)
    token_basis = target / TOKEN_BASIS
    if not token_basis.is_file():
        raise RuntimeError(f"token 추정 기준 파일이 없습니다: {token_basis}")
    document = create_changeset_skeleton(target, changeset_id)
    state: dict[str, object] = {
        "changeset_id": changeset_id,
        "status": "active",
        "branch": branch,
        "base": "recovered",
        "worktree": str(target),
        "token_estimation_basis": str(token_basis),
        "changeset_document": str(document),
        "copied": copied,
        "resumed": True,
        "recovered": True,
        "state_file": str(state_path(root, changeset_id)),
    }
    write_state(root, state)
    return state


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
        if not has_ref(root, f"refs/heads/{branch}"):
            raise SystemExit(f"worktree 경로가 이미 있습니다: {target}")
        print(json.dumps(recover_existing_worktree(root, changeset_id, branch, target), ensure_ascii=False))
        return
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
        changeset_document = create_changeset_skeleton(target, changeset_id)
        state = {
            "changeset_id": changeset_id,
            "status": "active",
            "branch": branch,
            "base": base,
            "worktree": str(target),
            "token_estimation_basis": str(token_basis),
            "changeset_document": str(changeset_document),
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
