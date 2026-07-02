"""Scope-safe ChangeSet pull-request delivery with final gate reconciliation."""

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
    _in_scope,
    _is_runtime_generated_path,
    _parse_pr_payload,
    _require_delivery_approval,
    _require_git_worktree,
    _run,
    _write_delivery_scope_report,
    _write_pr_result,
    resolve_delivery_scope,
)
from harness_codex.runtime.changes.models import ChangeSet, WorkItemType
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.gate_policy import (
    GateEscalation,
    derive_gate_policy,
    reconcile_observed_change_gates,
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
    """Commit only approved scope, then create or reuse the ChangeSet PR.

    Reconciliation is based on the whole branch diff against the PR base plus any
    uncommitted files. Already committed changes therefore cannot bypass scope or
    gate checks when delivery is resumed.
    """

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
    delivery_branch = _delivery_branch(change_set_id)

    change_set = _load_change_set(repo_root, change_set_id)
    scope = resolve_delivery_scope(repo_root, change_set_id)
    delivery_artifacts = _delivery_artifact_paths(run_id)
    dirty_paths = tuple(path for path in _changed_paths(repo_root) if path not in delivery_artifacts)
    observed_paths = _observed_delivery_paths(repo_root, base_branch, dirty_paths)
    outside_scope = tuple(path for path in observed_paths if not _in_scope(path, scope))
    _write_delivery_scope_report(
        repo_root,
        run_id=run_id,
        change_set_id=change_set_id,
        scope=scope,
        changed_paths=observed_paths,
        outside_scope=outside_scope,
    )
    if outside_scope:
        raise DeliveryBlocked(
            "ChangeSet 범위 밖 변경을 스테이징하지 않고 보존했습니다: " + ", ".join(outside_scope)
        )

    escalations = _reconcile_final_changed_paths(repo_root, change_set_id, observed_paths)
    _write_observed_gate_report(repo_root, run_id, change_set_id, observed_paths, escalations)
    if escalations:
        gate_ids = ", ".join(escalation.gate_id for escalation in escalations)
        raise DeliveryBlocked(
            "실제 변경 파일에 필요한 검사가 ChangeSet 영향도에서 제외되어 있습니다: "
            f"{gate_ids}. ChangeSet 영향도를 수정하고 필요한 검증을 다시 실행한 뒤 PR을 생성하세요."
        )

    staged_before = _git_lines(repo_root, "diff", "--cached", "--name-only")
    staged_outside_scope = tuple(path for path in staged_before if not _in_scope(path, scope))
    if staged_outside_scope:
        raise DeliveryBlocked(
            "인덱스에 ChangeSet 범위 밖 변경이 있어 커밋하지 않았습니다: "
            + ", ".join(staged_outside_scope)
        )
    if dirty_paths:
        _git_add_paths(repo_root, dirty_paths)

    staged_paths = _git_lines(repo_root, "diff", "--cached", "--name-only")
    staged_outside_scope = tuple(path for path in staged_paths if not _in_scope(path, scope))
    if staged_outside_scope:
        raise DeliveryBlocked("범위 밖 스테이징 변경의 커밋을 거부했습니다: " + ", ".join(staged_outside_scope))
    if staged_paths:
        committed = _run(repo_root, "git", "commit", "-m", f"{change_set_id} 변경사항 완료")
        if committed.returncode != 0:
            raise DeliveryBlocked(_command_error(committed))

    pushed = _run(
        repo_root,
        "git",
        "push",
        "--force-with-lease",
        "origin",
        f"HEAD:refs/heads/{delivery_branch}",
    )
    if pushed.returncode != 0:
        raise DeliveryBlocked(_command_error(pushed))

    existing = _run(repo_root, "gh", "pr", "view", delivery_branch, "--json", "url,number,title")
    if existing.returncode == 0:
        _edit_existing_pr_metadata(repo_root, change_set, run_id=run_id, observed_paths=observed_paths)
        result = _result(change_set_id, delivery_branch, base_branch, staged_paths, existing.stdout, True)
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
        delivery_branch,
        "--title",
        _pr_title(change_set),
        "--body",
        _pr_body(change_set, run_id=run_id, observed_paths=observed_paths),
    )
    if created.returncode != 0:
        existing = _run(repo_root, "gh", "pr", "view", delivery_branch, "--json", "url,number,title")
        if existing.returncode == 0:
            _edit_existing_pr_metadata(repo_root, change_set, run_id=run_id, observed_paths=observed_paths)
            result = _result(change_set_id, delivery_branch, base_branch, staged_paths, existing.stdout, True)
            _write_pr_result(repo_root, run_id, result)
            return result
        raise DeliveryBlocked(_command_error(created))

    result = _result(change_set_id, delivery_branch, base_branch, staged_paths, created.stdout, False)
    _write_pr_result(repo_root, run_id, result)
    return result


def _observed_delivery_paths(
    repo_root: Path,
    base_branch: str,
    dirty_paths: tuple[str, ...],
) -> tuple[str, ...]:
    """기준 브랜치에 없는 커밋 경로와 미커밋 경로를 반환한다."""

    base_ref = _resolve_base_ref(repo_root, base_branch)
    merge_base = _git_stdout(repo_root, "merge-base", base_ref, "HEAD")
    if not merge_base:
        raise DeliveryBlocked(f"PR 기준 브랜치와 공통 조상을 찾을 수 없습니다: {base_ref}")
    committed_paths = _git_lines(
        repo_root,
        "log",
        "--right-only",
        "--cherry-pick",
        "--name-only",
        "--format=",
        f"{base_ref}...HEAD",
    )
    observed = (
        path
        for path in (*committed_paths, *dirty_paths)
        if path and not _is_runtime_generated_path(path)
    )
    return tuple(dict.fromkeys(observed))


def _resolve_base_ref(repo_root: Path, base_branch: str) -> str:
    for candidate in (f"origin/{base_branch}", base_branch):
        resolved = _run(repo_root, "git", "rev-parse", "--verify", "--quiet", candidate)
        if resolved.returncode == 0:
            return candidate
    raise DeliveryBlocked(f"PR 기준 브랜치를 찾을 수 없습니다: {base_branch}")


def _delivery_branch(change_set_id: str) -> str:
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_"} else "-" for ch in change_set_id)
    return f"harness/{safe}/delivery"


def _reconcile_final_changed_paths(
    repo_root: Path,
    change_set_id: str,
    changed_paths: tuple[str, ...],
) -> tuple[GateEscalation, ...]:
    """Prevent delivery when actual files need a gate the ChangeSet skipped."""

    change_set_path = repo_root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_set_path.is_file():
        raise DeliveryBlocked(f"활성 ChangeSet 파일을 찾을 수 없습니다: {change_set_path}")
    change_set = parse_changeset_markdown(
        change_set_path.read_text(encoding="utf-8"),
        path=change_set_path.relative_to(repo_root),
    )
    policies = tuple(
        derive_gate_policy(
            work_item_id=item.work_item_id,
            work_item_type=item.work_item_type,
            impact_type=item.impact_type,
        )
        for item in change_set.ordered_work_items()
    )
    return reconcile_observed_change_gates(policies, changed_paths)


def _load_change_set(repo_root: Path, change_set_id: str) -> ChangeSet:
    change_set_path = repo_root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_set_path.is_file():
        raise DeliveryBlocked(f"활성 ChangeSet 파일을 찾을 수 없습니다: {change_set_path}")
    return parse_changeset_markdown(
        change_set_path.read_text(encoding="utf-8"),
        path=change_set_path.relative_to(repo_root),
    )


def _write_observed_gate_report(
    repo_root: Path,
    run_id: str,
    change_set_id: str,
    changed_paths: tuple[str, ...],
    escalations: tuple[GateEscalation, ...],
) -> Path:
    path = repo_root / ".harness/runs" / run_id / "observed-gate-reconciliation.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "change_set_id": change_set_id,
                "changed_paths": list(changed_paths),
                "status": "blocked" if escalations else "passed",
                "escalations": [escalation.as_dict() for escalation in escalations],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return path


def _delivery_artifact_paths(run_id: str) -> frozenset[str]:
    run_root = Path(".harness/runs") / run_id
    return frozenset(
        (
            (run_root / "delivery-scope.json").as_posix(),
            (run_root / "observed-gate-reconciliation.json").as_posix(),
            (run_root / "pull-request.json").as_posix(),
        )
    )


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


def _pr_title(change_set: ChangeSet) -> str:
    prefix = _pr_type_prefix(change_set)
    summary = _pr_summary(change_set)
    return f"{prefix}: {change_set.change_set_id} {summary}"


def _edit_existing_pr_metadata(
    repo_root: Path,
    change_set: ChangeSet,
    *,
    run_id: str,
    observed_paths: tuple[str, ...],
) -> None:
    edited = _run(
        repo_root,
        "gh",
        "pr",
        "edit",
        "--title",
        _pr_title(change_set),
        "--body",
        _pr_body(change_set, run_id=run_id, observed_paths=observed_paths),
    )
    if edited.returncode != 0:
        raise DeliveryBlocked(_command_error(edited))


def _pr_type_prefix(change_set: ChangeSet) -> str:
    work_items = change_set.ordered_work_items()
    text = " ".join(
        (
            change_set.title,
            change_set.intent_summary,
            change_set.before_summary,
            " ".join(item.name for item in work_items),
            " ".join(item.impact_type for item in work_items),
        )
    ).casefold()
    if any(item.work_item_type is WorkItemType.BUG_FIX for item in work_items):
        return "fix"
    if any(token in text for token in ("bug", "fix", "오류", "버그", "실패", "수정")):
        return "fix"
    if any(item.work_item_type is WorkItemType.REFACTORING for item in work_items):
        return "refactor"
    if any(token in text for token in ("refactor", "cleanup", "리팩터", "정리", "구조")):
        return "refactor"
    return "feat"


def _one_line_summary(value: str) -> str:
    summary = " ".join(value.strip().split())
    return summary[:80].rstrip() or "변경 사항 전달"


def _pr_summary(change_set: ChangeSet) -> str:
    candidates = (
        change_set.intent_summary,
        change_set.title,
        ", ".join(item.name for item in change_set.ordered_work_items()),
    )
    generic = {
        "",
        change_set.change_set_id.casefold(),
        f"changeset {change_set.change_set_id}".casefold(),
        f"change set {change_set.change_set_id}".casefold(),
    }
    for candidate in candidates:
        if not candidate.strip():
            continue
        summary = _one_line_summary(candidate)
        if summary.casefold() not in generic:
            return summary
    return "변경 사항 전달"


def _pr_body(
    change_set: ChangeSet,
    *,
    run_id: str,
    observed_paths: tuple[str, ...],
) -> str:
    work_items = change_set.ordered_work_items()
    requirement_lines = [
        f"- `{item.work_item_id}` {item.name}: {item.impact_type or '-'}"
        for item in work_items
    ] or ["- 등록된 work item 없음"]
    scope_lines = [
        f"- `{_strip_code_ticks(pattern)}`"
        for pattern in change_set.included_scope
    ] or ["- ChangeSet에 선언된 포함 범위 기준"]
    changed_sample = [f"- `{path}`" for path in observed_paths[:12]]
    if len(observed_paths) > 12:
        changed_sample.append(f"- 외 {len(observed_paths) - 12}개 경로")
    return "\n".join(
        (
            "## 문제사항/구현요구사항",
            "",
            f"- ChangeSet: `{change_set.change_set_id}`",
            f"- 요약: {_one_line_summary(change_set.title or change_set.intent_summary)}",
            f"- 요청: {change_set.intent_summary or change_set.title or '-'}",
            f"- 기존 문제: {change_set.before_summary or '-'}",
            f"- 기대 결과: {change_set.after_summary or '-'}",
            "",
            "### 작업 항목",
            "",
            *requirement_lines,
            "",
            "## 해결 방안",
            "",
            "- ChangeSet에 선언된 범위 안의 변경만 PR 대상으로 스테이징했습니다.",
            "- PR 기준 브랜치와 비교해 실제 변경 파일을 다시 계산했습니다.",
            "- 실제 변경 파일이 요구하는 gate가 ChangeSet 영향도에 포함되는지 확인했습니다.",
            "- 명시적인 전달 승인 후 PR을 생성했습니다.",
            "",
            "### 포함 범위",
            "",
            *scope_lines,
            "",
            "## 검증 방법",
            "",
            f"- Harness run: `{run_id}`",
            "- delivery scope 검사 통과",
            "- observed gate reconciliation 통과",
            "- 완료된 work item plan 기반 구현 단계 통과",
            "",
            "### 주요 변경 경로",
            "",
            *(changed_sample or ["- 변경 경로 없음"]),
        )
    )


def _strip_code_ticks(value: str) -> str:
    return value.strip().strip("`")


if __name__ == "__main__":
    raise SystemExit(main())
