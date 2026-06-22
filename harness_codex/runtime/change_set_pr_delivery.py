"""범위 안전한 ChangeSet PR 전달 명령."""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Sequence

from harness_codex.runtime.change_set_delivery import (
    DeliveryBlocked,
    DeliveryResult,
    _changed_paths,
    _command_error,
    _default_base_branch,
    _git_add_paths,
    _git_lines,
    _git_stdout,
    _parse_pr_payload,
    _require_delivery_approval,
    _require_git_worktree,
    _run,
    _write_delivery_scope_report,
    _write_pr_result,
    resolve_delivery_scope,
    _in_scope,
)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)
    try:
        result = create_change_set_pull_request(
            Path(args.repo_root).resolve(),
            change_set_id=args.change_set,
            run_id=args.run_id,
        )
    except DeliveryBlocked as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
    return 0


def create_change_set_pull_request(
    repo_root: Path,
    *,
    change_set_id: str,
    run_id: str,
) -> DeliveryResult:
    """허용된 ChangeSet 경로만 커밋하고 한국어 PR을 생성·재사용한다."""

    _require_delivery_approval()
    if shutil.which("gh") is None:
        raise DeliveryBlocked("ChangeSet PR 생성에는 GitHub CLI `gh`가 필요합니다")
    _require_git_worktree(repo_root)

    branch = _git_stdout(repo_root, "branch", "--show-current")
    if not branch:
        raise DeliveryBlocked("대상 저장소에 현재 브랜치가 없습니다")
    origin = _run(repo_root, "git", "remote", "get-url", "origin")
    if origin.returncode != 0 or not origin.stdout.strip():
        raise DeliveryBlocked("대상 저장소에 origin remote가 없습니다")
    base_branch = _default_base_branch(repo_root)
    if branch == base_branch:
        raise DeliveryBlocked(f"현재 브랜치 `{branch}`는 PR 기준 브랜치입니다")

    scope = resolve_delivery_scope(repo_root, change_set_id)
    changed_paths = _changed_paths(repo_root)
    outside_scope = tuple(path for path in changed_paths if not _in_scope(path, scope))
    _write_delivery_scope_report(
        repo_root,
        run_id=run_id,
        change_set_id=change_set_id,
        scope=scope,
        changed_paths=changed_paths,
        outside_scope=outside_scope,
    )
    if outside_scope:
        raise DeliveryBlocked(
            "ChangeSet 범위 밖 변경을 스테이징하지 않고 보존했습니다: " + ", ".join(outside_scope)
        )

    staged_before = _git_lines(repo_root, "diff", "--cached", "--name-only")
    staged_outside_scope = tuple(path for path in staged_before if not _in_scope(path, scope))
    if staged_outside_scope:
        raise DeliveryBlocked(
            "인덱스에 ChangeSet 범위 밖 변경이 있어 커밋하지 않았습니다: "
            + ", ".join(staged_outside_scope)
        )
    if changed_paths:
        _git_add_paths(repo_root, changed_paths)

    staged_paths = _git_lines(repo_root, "diff", "--cached", "--name-only")
    staged_outside_scope = tuple(path for path in staged_paths if not _in_scope(path, scope))
    if staged_outside_scope:
        raise DeliveryBlocked("범위 밖 스테이징 변경의 커밋을 거부했습니다: " + ", ".join(staged_outside_scope))
    if staged_paths:
        committed = _run(repo_root, "git", "commit", "-m", f"{change_set_id} 변경사항 완료")
        if committed.returncode != 0:
            raise DeliveryBlocked(_command_error(committed))

    pushed = _run(repo_root, "git", "push", "-u", "origin", "HEAD")
    if pushed.returncode != 0:
        raise DeliveryBlocked(_command_error(pushed))

    existing = _run(repo_root, "gh", "pr", "view", "--json", "url,number,title")
    if existing.returncode == 0:
        result = _result(change_set_id, branch, base_branch, staged_paths, existing.stdout, True)
        _write_pr_result(repo_root, run_id, result)
        return result

    created = _run(
        repo_root,
        "gh",
        "pr",
        "create",
        "--base",
        base_branch,
        "--head",
        branch,
        "--title",
        f"{change_set_id} 변경 세트 전달",
        "--body",
        _pr_body(change_set_id),
    )
    if created.returncode != 0:
        existing = _run(repo_root, "gh", "pr", "view", "--json", "url,number,title")
        if existing.returncode == 0:
            result = _result(change_set_id, branch, base_branch, staged_paths, existing.stdout, True)
            _write_pr_result(repo_root, run_id, result)
            return result
        raise DeliveryBlocked(_command_error(created))

    result = _result(change_set_id, branch, base_branch, staged_paths, created.stdout, False)
    _write_pr_result(repo_root, run_id, result)
    return result


def _result(
    change_set_id: str,
    branch: str,
    base_branch: str,
    staged_paths: tuple[str, ...],
    raw: str,
    already_exists: bool,
) -> DeliveryResult:
    payload = _parse_pr_payload(raw)
    return DeliveryResult(
        change_set_id=change_set_id,
        branch=branch,
        base_branch=base_branch,
        committed_paths=staged_paths,
        pull_request=str(payload.get("url") or raw.strip()),
        already_exists=already_exists,
    )


def _pr_body(change_set_id: str) -> str:
    return "\n".join(
        (
            "## ChangeSet",
            "",
            f"- ChangeSet: `{change_set_id}`",
            "",
            "## 전달 안전성",
            "",
            "- ChangeSet 범위로 승인된 경로만 스테이징했습니다.",
            "- 명시적인 전달 승인 후에만 PR을 생성했습니다.",
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
