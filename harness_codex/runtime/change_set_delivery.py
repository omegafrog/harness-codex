"""Scope-safe, explicitly approved ChangeSet delivery operations.

This module is intentionally independent from the workflow runner so delivery can be
retried without changing ChangeSet completion state.  It stages only files covered by
the ChangeSet contract; unrelated worktree changes remain untouched.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable, Sequence

from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.completion import ChangeSetCompletionBlocked, complete_change_set_if_ready


DELIVERY_APPROVAL_ENV = "HARNESS_DELIVERY_APPROVED"
_PATH_CODE_RE = re.compile(r"`([^`]+)`")


class DeliveryBlocked(RuntimeError):
    """Raised when delivery must stop without changing ChangeSet completion state."""


@dataclass(frozen=True)
class DeliveryScope:
    allowed_patterns: tuple[str, ...]
    blocked_patterns: tuple[str, ...]


@dataclass(frozen=True)
class DeliveryResult:
    change_set_id: str
    branch: str
    base_branch: str
    committed_paths: tuple[str, ...]
    pull_request: str
    already_exists: bool


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("pull-request", "complete"))
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)

    try:
        if args.action == "pull-request":
            result = create_change_set_pull_request(
                Path(args.repo_root).resolve(),
                change_set_id=args.change_set,
                run_id=args.run_id,
            )
            print(json.dumps(asdict(result), ensure_ascii=False, indent=2))
        else:
            result = complete_change_set_delivery(
                Path(args.repo_root).resolve(),
                change_set_id=args.change_set,
                run_id=args.run_id,
            )
            print(json.dumps(result, ensure_ascii=False, indent=2))
    except DeliveryBlocked as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    return 0


def create_change_set_pull_request(
    repo_root: Path,
    *,
    change_set_id: str,
    run_id: str,
) -> DeliveryResult:
    """Commit only in-scope changes, push them, then create or reuse a PR."""

    _require_delivery_approval()
    if shutil.which("gh") is None:
        raise DeliveryBlocked("GitHub CLI `gh` is required to create ChangeSet PR")
    _require_git_worktree(repo_root)

    branch = _git_stdout(repo_root, "branch", "--show-current")
    if not branch:
        raise DeliveryBlocked("target repo has no current branch")
    origin = _run(repo_root, "git", "remote", "get-url", "origin")
    if origin.returncode != 0 or not origin.stdout.strip():
        raise DeliveryBlocked("target repo has no origin remote")

    base_branch = _default_base_branch(repo_root)
    if branch == base_branch:
        raise DeliveryBlocked(f"current branch `{branch}` is the PR base branch")

    scope = resolve_delivery_scope(repo_root, change_set_id)
    changed_paths = _changed_paths(repo_root)
    outside_scope = tuple(sorted(path for path in changed_paths if not _in_scope(path, scope)))
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
            "dirty worktree contains ChangeSet-out-of-scope changes; preserved without staging: "
            + ", ".join(outside_scope)
        )

    staged_before = set(_git_lines(repo_root, "diff", "--cached", "--name-only"))
    staged_outside_scope = tuple(sorted(path for path in staged_before if not _in_scope(path, scope)))
    if staged_outside_scope:
        raise DeliveryBlocked(
            "index contains ChangeSet-out-of-scope changes; preserved without committing: "
            + ", ".join(staged_outside_scope)
        )

    if changed_paths:
        _git_add_paths(repo_root, changed_paths)

    staged_paths = tuple(sorted(_git_lines(repo_root, "diff", "--cached", "--name-only")))
    staged_outside_scope = tuple(path for path in staged_paths if not _in_scope(path, scope))
    if staged_outside_scope:
        raise DeliveryBlocked(
            "refusing to commit ChangeSet-out-of-scope staged changes: "
            + ", ".join(staged_outside_scope)
        )

    if staged_paths:
        committed = _run(repo_root, "git", "commit", "-m", f"{change_set_id} 변경사항 완료")
        if committed.returncode != 0:
            raise DeliveryBlocked(_command_error(committed))

    pushed = _run(repo_root, "git", "push", "-u", "origin", "HEAD")
    if pushed.returncode != 0:
        raise DeliveryBlocked(_command_error(pushed))

    existing = _run(repo_root, "gh", "pr", "view", "--json", "url,number,title")
    if existing.returncode == 0:
        payload = _parse_pr_payload(existing.stdout)
        result = DeliveryResult(
            change_set_id=change_set_id,
            branch=branch,
            base_branch=base_branch,
            committed_paths=staged_paths,
            pull_request=str(payload.get("url") or existing.stdout.strip()),
            already_exists=True,
        )
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
        f"{change_set_id} ChangeSet delivery",
        "--body",
        _change_set_pr_body(change_set_id),
    )
    if created.returncode != 0:
        existing = _run(repo_root, "gh", "pr", "view", "--json", "url,number,title")
        if existing.returncode == 0:
            payload = _parse_pr_payload(existing.stdout)
            result = DeliveryResult(
                change_set_id=change_set_id,
                branch=branch,
                base_branch=base_branch,
                committed_paths=staged_paths,
                pull_request=str(payload.get("url") or existing.stdout.strip()),
                already_exists=True,
            )
            _write_pr_result(repo_root, run_id, result)
            return result
        raise DeliveryBlocked(_command_error(created))

    payload = _parse_pr_payload(created.stdout)
    result = DeliveryResult(
        change_set_id=change_set_id,
        branch=branch,
        base_branch=base_branch,
        committed_paths=staged_paths,
        pull_request=str(payload.get("url") or created.stdout.strip()),
        already_exists=False,
    )
    _write_pr_result(repo_root, run_id, result)
    return result


def complete_change_set_delivery(
    repo_root: Path,
    *,
    change_set_id: str,
    run_id: str,
) -> dict[str, object]:
    """Complete and push the ChangeSet without broad staging.

    This runs only after PR delivery.  A failed push leaves the completed ChangeSet
    available for a later retry and never stages unrelated paths.
    """

    _require_delivery_approval()
    _require_git_worktree(repo_root)
    dirty_before = _changed_paths(repo_root)
    if dirty_before:
        raise DeliveryBlocked(
            "dirty worktree blocks ChangeSet completion; preserved without staging: "
            + ", ".join(sorted(dirty_before))
        )

    active_path = repo_root / "docs/changes/active" / f"{change_set_id}.md"
    completed_path = repo_root / "docs/changes/completed" / f"{change_set_id}.md"
    completion_report = repo_root / ".harness/runs" / run_id / "changeset-completion-report.md"
    already_completed = completed_path.exists() and not active_path.exists()

    if not already_completed:
        if not active_path.exists():
            raise DeliveryBlocked(f"active ChangeSet file not found: {active_path.relative_to(repo_root)}")
        change_set = parse_changeset_markdown(
            active_path.read_text(encoding="utf-8"),
            path=str(active_path.relative_to(repo_root)),
        )
        try:
            complete_change_set_if_ready(repo_root, change_set, run_id=run_id)
        except ChangeSetCompletionBlocked as exc:
            raise DeliveryBlocked(f"ChangeSet completion blocked: {exc.reason}") from exc

    _git_add_paths(
        repo_root,
        (
            active_path.relative_to(repo_root).as_posix(),
            completed_path.relative_to(repo_root).as_posix(),
        ),
    )
    staged_paths = tuple(sorted(_git_lines(repo_root, "diff", "--cached", "--name-only")))
    allowed_completion_paths = {
        active_path.relative_to(repo_root).as_posix(),
        completed_path.relative_to(repo_root).as_posix(),
    }
    unexpected = tuple(path for path in staged_paths if path not in allowed_completion_paths)
    if unexpected:
        raise DeliveryBlocked(
            "refusing to commit non-completion paths: " + ", ".join(unexpected)
        )
    if staged_paths:
        committed = _run(repo_root, "git", "commit", "-m", f"{change_set_id} ChangeSet completion")
        if committed.returncode != 0:
            raise DeliveryBlocked(_command_error(committed))

    pushed = _run(repo_root, "git", "push", "origin", "HEAD")
    if pushed.returncode != 0:
        raise DeliveryBlocked(_command_error(pushed))

    return {
        "change_set_id": change_set_id,
        "completed_path": completed_path.relative_to(repo_root).as_posix(),
        "completion_report": completion_report.relative_to(repo_root).as_posix(),
        "already_completed": already_completed,
        "committed_paths": staged_paths,
    }


def resolve_delivery_scope(repo_root: Path, change_set_id: str) -> DeliveryScope:
    """Resolve delivery paths from the ChangeSet and per-work-item contracts."""

    change_set_path = repo_root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_set_path.is_file():
        raise DeliveryBlocked(f"missing active ChangeSet file: {change_set_path.relative_to(repo_root)}")
    change_set = parse_changeset_markdown(
        change_set_path.read_text(encoding="utf-8"),
        path=str(change_set_path.relative_to(repo_root)),
    )

    allowed: list[str] = [change_set_path.relative_to(repo_root).as_posix()]
    allowed.extend(document.path.as_posix() for document in change_set.changed_documents)
    allowed.extend(_extract_path_patterns(change_set.included_scope))
    blocked = _extract_path_patterns(change_set.excluded_scope + change_set.forbidden_changes)

    for item in change_set.ordered_work_items():
        work_item_id = item.work_item_id
        allowed.extend(
            (
                f"docs/plans/active/{work_item_id}/plan.md",
                f"docs/plans/completed/{work_item_id}/plan.md",
            )
        )
    normalized_allowed = tuple(dict.fromkeys(_normalize_pattern(value) for value in allowed if _normalize_pattern(value)))
    normalized_blocked = tuple(dict.fromkeys(_normalize_pattern(value) for value in blocked if _normalize_pattern(value)))
    if not normalized_allowed:
        raise DeliveryBlocked("ChangeSet delivery scope has no allowed paths")
    return DeliveryScope(normalized_allowed, normalized_blocked)


def _extract_path_patterns(values: Iterable[str]) -> list[str]:
    patterns: list[str] = []
    for value in values:
        patterns.extend(match.group(1) for match in _PATH_CODE_RE.finditer(value))
    return patterns


def _normalize_pattern(value: str) -> str:
    pattern = value.strip().strip("|,;:)").removeprefix("./")
    if not pattern or "/" not in pattern:
        return ""
    return pattern


def _in_scope(path: str, scope: DeliveryScope) -> bool:
    if any(_matches(path, pattern) for pattern in scope.blocked_patterns):
        return False
    return any(_matches(path, pattern) for pattern in scope.allowed_patterns)


def _matches(path: str, pattern: str) -> bool:
    if pattern.endswith("/**"):
        root = pattern[:-3].rstrip("/")
        return path == root or path.startswith(root + "/")
    return fnmatch.fnmatchcase(path, pattern)


def _changed_paths(repo_root: Path) -> tuple[str, ...]:
    paths: set[str] = set()
    for args in (
        ("diff", "--name-only"),
        ("diff", "--cached", "--name-only"),
        ("ls-files", "--others", "--exclude-standard"),
    ):
        paths.update(_git_lines(repo_root, *args))
    return tuple(sorted(paths))


def _git_add_paths(repo_root: Path, paths: Iterable[str]) -> None:
    unique = tuple(dict.fromkeys(path for path in paths if path))
    if not unique:
        return
    added = _run(repo_root, "git", "add", "--", *unique)
    if added.returncode != 0:
        raise DeliveryBlocked(_command_error(added))


def _require_delivery_approval() -> None:
    value = os.environ.get(DELIVERY_APPROVAL_ENV, "").strip().lower()
    if value not in {"1", "true", "yes"}:
        raise DeliveryBlocked(
            f"explicit delivery approval is required; set {DELIVERY_APPROVAL_ENV}=1"
        )


def _require_git_worktree(repo_root: Path) -> None:
    checked = _run(repo_root, "git", "rev-parse", "--is-inside-work-tree")
    if checked.returncode != 0 or checked.stdout.strip() != "true":
        raise DeliveryBlocked("target repo is not a git worktree")


def _default_base_branch(repo_root: Path) -> str:
    remote_head = _git_stdout(repo_root, "symbolic-ref", "refs/remotes/origin/HEAD", "--short")
    if remote_head.startswith("origin/"):
        return remote_head.split("/", 1)[1]
    return "main"


def _git_stdout(repo_root: Path, *args: str) -> str:
    completed = _run(repo_root, "git", *args)
    return completed.stdout.strip() if completed.returncode == 0 else ""


def _git_lines(repo_root: Path, *args: str) -> tuple[str, ...]:
    completed = _run(repo_root, "git", *args)
    if completed.returncode != 0:
        raise DeliveryBlocked(_command_error(completed))
    return tuple(line.strip() for line in completed.stdout.splitlines() if line.strip())


def _run(repo_root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )


def _command_error(completed: subprocess.CompletedProcess[str]) -> str:
    return completed.stderr.strip() or completed.stdout.strip() or "delivery command failed"


def _change_set_pr_body(change_set_id: str) -> str:
    return "\n".join(
        (
            f"## ChangeSet\n\n- ChangeSet: `{change_set_id}`",
            "\n## Delivery safety\n\n- Only ChangeSet-scoped paths were staged.",
            "- Delivery required explicit approval via `HARNESS_DELIVERY_APPROVED=1`.",
        )
    )


def _parse_pr_payload(raw: str) -> dict[str, object]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"url": raw.strip()}
    return parsed if isinstance(parsed, dict) else {"url": raw.strip()}


def _write_pr_result(repo_root: Path, run_id: str, result: DeliveryResult) -> None:
    target = repo_root / ".harness/runs" / run_id / "pull-request.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(asdict(result), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _write_delivery_scope_report(
    repo_root: Path,
    *,
    run_id: str,
    change_set_id: str,
    scope: DeliveryScope,
    changed_paths: Sequence[str],
    outside_scope: Sequence[str],
) -> None:
    target = repo_root / ".harness/runs" / run_id / "delivery-scope.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(
            {
                "change_set_id": change_set_id,
                "allowed_patterns": scope.allowed_patterns,
                "blocked_patterns": scope.blocked_patterns,
                "changed_paths": list(changed_paths),
                "outside_scope": list(outside_scope),
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    raise SystemExit(main())
