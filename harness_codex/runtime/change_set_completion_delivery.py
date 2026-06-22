"""범위 안전한 최종 ChangeSet 완료 명령."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Sequence

from harness_codex.runtime.change_set_delivery import (
    DELIVERY_APPROVAL_ENV,
    DeliveryBlocked,
    _changed_paths,
    _command_error,
    _git_add_paths,
    _git_lines,
    _require_delivery_approval,
    _require_git_worktree,
    _run,
)
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.completion import ChangeSetCompletionBlocked, complete_change_set_if_ready


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)
    try:
        result = complete_change_set_delivery(
            Path(args.repo_root).resolve(),
            change_set_id=args.change_set,
            run_id=args.run_id,
        )
    except DeliveryBlocked as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


def complete_change_set_delivery(
    repo_root: Path,
    *,
    change_set_id: str,
    run_id: str,
) -> dict[str, object]:
    """활성/완료 ChangeSet 경로만 이동·커밋·푸시한다."""

    _require_delivery_approval()
    _require_git_worktree(repo_root)
    dirty_before = _changed_paths(repo_root)
    if dirty_before:
        raise DeliveryBlocked(
            "작업 트리가 변경되어 ChangeSet 완료를 중단했습니다. 스테이징하지 않고 보존한 경로: "
            + ", ".join(dirty_before)
        )

    active_relative = Path("docs/changes/active") / f"{change_set_id}.md"
    completed_relative = Path("docs/changes/completed") / f"{change_set_id}.md"
    active_path = repo_root / active_relative
    completed_path = repo_root / completed_relative
    already_completed = completed_path.exists() and not active_path.exists()

    if not already_completed:
        if not active_path.exists():
            raise DeliveryBlocked(f"활성 ChangeSet 파일이 없습니다: {active_relative}")
        change_set = parse_changeset_markdown(
            active_path.read_text(encoding="utf-8"),
            path=active_relative,
        )
        try:
            complete_change_set_if_ready(repo_root, change_set, run_id=run_id)
        except ChangeSetCompletionBlocked as exc:
            raise DeliveryBlocked(f"ChangeSet 완료 조건이 충족되지 않았습니다: {exc.reason}") from exc

    _git_add_paths(repo_root, (active_relative.as_posix(), completed_relative.as_posix()))
    staged_paths = _git_lines(repo_root, "diff", "--cached", "--name-only")
    allowed = {active_relative.as_posix(), completed_relative.as_posix()}
    unexpected = tuple(path for path in staged_paths if path not in allowed)
    if unexpected:
        raise DeliveryBlocked("완료와 무관한 경로의 커밋을 거부했습니다: " + ", ".join(unexpected))
    if staged_paths:
        _require_success(_run(repo_root, "git", "commit", "-m", f"{change_set_id} 변경 세트 완료"))
    _require_success(_run(repo_root, "git", "push", "origin", "HEAD"))

    return {
        "change_set_id": change_set_id,
        "completed_path": completed_relative.as_posix(),
        "completion_report": str(Path(".harness/runs") / run_id / "changeset-completion-report.md"),
        "already_completed": already_completed,
        "committed_paths": staged_paths,
        "approval_env": DELIVERY_APPROVAL_ENV,
    }


def _require_success(completed) -> None:
    if completed.returncode != 0:
        raise DeliveryBlocked(_command_error(completed))


if __name__ == "__main__":
    raise SystemExit(main())
