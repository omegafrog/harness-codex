"""Scope-safe final ChangeSet completion command.

This is deliberately separate from PR delivery: an interrupted or failed delivery can
be retried without moving an active ChangeSet or staging unrelated worktree changes.
"""

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
    _git_add_paths,
    _git_lines,
    _require_delivery_approval,
    _require_git_worktree,
    _require_success,
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
    """Move and commit only the active/completed ChangeSet paths."""

    _require_delivery_approval()
    _require_git_worktree(repo_root)
    dirty_before = _changed_paths(repo_root)
    if dirty_before:
        raise DeliveryBlocked(
            "dirty worktree blocks ChangeSet completion; preserved without staging: "
            + ", ".join(dirty_before)
        )

    active_relative = Path("docs/changes/active") / f"{change_set_id}.md"
    completed_relative = Path("docs/changes/completed") / f"{change_set_id}.md"
    active_path = repo_root / active_relative
    completed_path = repo_root / completed_relative
    already_completed = completed_path.exists() and not active_path.exists()

    if not already_completed:
        if not active_path.exists():
            raise DeliveryBlocked(f"active ChangeSet file not found: {active_relative}")
        change_set = parse_changeset_markdown(
            active_path.read_text(encoding="utf-8"),
            path=active_relative,
        )
        try:
            complete_change_set_if_ready(repo_root, change_set, run_id=run_id)
        except ChangeSetCompletionBlocked as exc:
            raise DeliveryBlocked(f"ChangeSet completion blocked: {exc.reason}") from exc

    _git_add_paths(repo_root, (active_relative.as_posix(), completed_relative.as_posix()))
    staged_paths = _git_lines(repo_root, "diff", "--cached", "--name-only")
    allowed = {active_relative.as_posix(), completed_relative.as_posix()}
    unexpected = tuple(path for path in staged_paths if path not in allowed)
    if unexpected:
        raise DeliveryBlocked("refusing to commit non-completion paths: " + ", ".join(unexpected))
    if staged_paths:
        _require_success(_run(repo_root, "git", "commit", "-m", f"{change_set_id} ChangeSet completion"))
    _require_success(_run(repo_root, "git", "push", "origin", "HEAD"))

    return {
        "change_set_id": change_set_id,
        "completed_path": completed_relative.as_posix(),
        "completion_report": str(Path(".harness/runs") / run_id / "changeset-completion-report.md"),
        "already_completed": already_completed,
        "committed_paths": staged_paths,
        "approval_env": DELIVERY_APPROVAL_ENV,
    }


if __name__ == "__main__":
    raise SystemExit(main())
