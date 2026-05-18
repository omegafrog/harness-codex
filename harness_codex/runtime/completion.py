"""ChangeSet final completion gate and archive workflow."""

from __future__ import annotations

import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.changes.models import ChangeSet


class ChangeSetCompletionBlocked(RuntimeError):
    """Raised when a ChangeSet is not ready for final completion."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class ChangeSetCompletionResult:
    """Result of a ChangeSet final completion attempt."""

    change_set_id: str
    active_path: Path
    completed_path: Path
    report_path: Path
    completed_work_items: tuple[str, ...]
    completed_plan_paths: tuple[Path, ...]
    run_id: str | None = None
    already_completed: bool = False


def complete_change_set_if_ready(
    repo_root: Path | str,
    change_set: ChangeSet,
    *,
    run_id: str | None = None,
) -> ChangeSetCompletionResult:
    """Move an active ChangeSet to completed when all work items are done.

    The gate is intentionally fail-closed: it requires completed plans for every
    affected work item, no remaining active plans, and a successful run report.
    Runtime evidence under `.harness/runs` is preserved and a completion report
    is written next to the run report.
    """

    root = Path(repo_root)
    active_path = Path("docs/changes/active") / f"{change_set.change_set_id}.md"
    completed_path = Path("docs/changes/completed") / f"{change_set.change_set_id}.md"
    absolute_active = root / active_path
    absolute_completed = root / completed_path

    work_items = change_set.ordered_work_items()
    work_item_ids = tuple(item.work_item_id for item in work_items)
    completed_plan_paths = tuple(
        Path("docs/plans/completed") / item_id / "plan.md"
        for item_id in work_item_ids
    )

    effective_run_id = run_id or _latest_run_id_for_change_set(root, change_set.change_set_id)
    report_path = (
        Path(".harness/runs") / effective_run_id / "changeset-completion-report.md"
        if effective_run_id
        else Path(".harness/runs/UNKNOWN/changeset-completion-report.md")
    )

    if absolute_completed.exists() and not absolute_active.exists():
        return ChangeSetCompletionResult(
            change_set_id=change_set.change_set_id,
            active_path=active_path,
            completed_path=completed_path,
            report_path=report_path,
            completed_work_items=work_item_ids,
            completed_plan_paths=completed_plan_paths,
            run_id=effective_run_id,
            already_completed=True,
        )

    if absolute_completed.exists() and absolute_active.exists():
        raise ChangeSetCompletionBlocked(
            "completed ChangeSet already exists while active ChangeSet still exists: "
            f"{completed_path}"
        )

    if not absolute_active.exists():
        raise ChangeSetCompletionBlocked(
            f"active ChangeSet file does not exist: {active_path}"
        )

    if change_set.path is not None and change_set.path != active_path:
        raise ChangeSetCompletionBlocked(
            "ChangeSet ID and active path do not match: "
            f"id={change_set.change_set_id} path={change_set.path}"
        )

    if not work_items:
        raise ChangeSetCompletionBlocked("ChangeSet has no affected work items")

    blocked_statuses = tuple(
        f"{item.work_item_id}:{item.status}"
        for item in work_items
        if item.status.strip().lower() in {"failed", "blocked"}
    )
    if blocked_statuses:
        raise ChangeSetCompletionBlocked(
            "affected work items are failed or blocked: "
            + ", ".join(blocked_statuses)
        )

    missing_completed_plans = tuple(
        path for path in completed_plan_paths if not (root / path).exists()
    )
    if missing_completed_plans:
        raise ChangeSetCompletionBlocked(
            "missing completed work item plans: "
            + ", ".join(str(path) for path in missing_completed_plans)
        )

    active_plan_paths = tuple(
        Path("docs/plans/active") / item_id / "plan.md"
        for item_id in work_item_ids
        if (root / "docs/plans/active" / item_id / "plan.md").exists()
    )
    if active_plan_paths:
        raise ChangeSetCompletionBlocked(
            "active work item plans still exist: "
            + ", ".join(str(path) for path in active_plan_paths)
        )

    if effective_run_id is None:
        raise ChangeSetCompletionBlocked(
            f"no run state found for ChangeSet {change_set.change_set_id}"
        )

    run_report, run_report_path = _load_successful_run_report(
        root,
        effective_run_id,
        work_item_ids,
    )

    absolute_completed.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(absolute_active), str(absolute_completed))

    _write_completion_report(
        root,
        report_path,
        change_set=change_set,
        run_id=effective_run_id,
        active_path=active_path,
        completed_path=completed_path,
        completed_work_items=work_item_ids,
        completed_plan_paths=completed_plan_paths,
        run_report_path=run_report_path,
        run_report=run_report,
    )

    return ChangeSetCompletionResult(
        change_set_id=change_set.change_set_id,
        active_path=active_path,
        completed_path=completed_path,
        report_path=report_path,
        completed_work_items=work_item_ids,
        completed_plan_paths=completed_plan_paths,
        run_id=effective_run_id,
    )


def _latest_run_id_for_change_set(repo_root: Path, change_set_id: str) -> str | None:
    runs_dir = repo_root / ".harness/runs"
    if not runs_dir.exists():
        return None

    candidates: list[tuple[float, str]] = []
    for state_path in runs_dir.glob("*/state.json"):
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if data.get("change_set_id") == change_set_id:
            candidates.append((state_path.stat().st_mtime, state_path.parent.name))

    if not candidates:
        return None
    return sorted(candidates)[-1][1]


def _load_successful_run_report(
    repo_root: Path,
    run_id: str,
    work_item_ids: tuple[str, ...],
) -> tuple[Mapping[str, Any], Path]:
    report_path = Path(".harness/runs") / run_id / "report.json"
    absolute_report_path = repo_root / report_path
    if not absolute_report_path.exists():
        raise ChangeSetCompletionBlocked(f"latest run report does not exist: {report_path}")

    report = json.loads(absolute_report_path.read_text(encoding="utf-8"))
    if report.get("status") != "succeeded":
        raise ChangeSetCompletionBlocked(
            f"latest run did not succeed: run_id={run_id} status={report.get('status', '-') }"
        )

    failed_or_blocked = tuple(
        item_id
        for item_id in tuple(report.get("failed_use_cases", ()))
        + tuple(report.get("blocked_use_cases", ()))
        if item_id in work_item_ids
    )
    if failed_or_blocked:
        raise ChangeSetCompletionBlocked(
            "latest run report contains failed or blocked work items: "
            + ", ".join(failed_or_blocked)
        )

    work_item_reports = tuple(report.get("work_item_reports", ()))
    for item in work_item_reports:
        item_id = str(item.get("work_item_id", ""))
        if item_id in work_item_ids and item.get("status") != "succeeded":
            raise ChangeSetCompletionBlocked(
                "latest run report contains non-succeeded work item result: "
                f"{item_id}:{item.get('status', '-')}"
            )

    return report, report_path


def _write_completion_report(
    repo_root: Path,
    report_path: Path,
    *,
    change_set: ChangeSet,
    run_id: str,
    active_path: Path,
    completed_path: Path,
    completed_work_items: tuple[str, ...],
    completed_plan_paths: tuple[Path, ...],
    run_report_path: Path,
    run_report: Mapping[str, Any],
) -> None:
    path = repo_root / report_path
    path.parent.mkdir(parents=True, exist_ok=True)

    work_item_lines = [
        "| Work Item | Completed Plan |",
        "| --- | --- |",
        *[
            f"| `{item_id}` | `{plan_path}` |"
            for item_id, plan_path in zip(completed_work_items, completed_plan_paths)
        ],
    ]
    verification_result = run_report.get("status", "-")
    work_item_results = run_report.get("work_item_reports", ())
    verification_lines = [
        f"- Run report: `{run_report_path}`",
        f"- Run status: {verification_result}",
    ]
    for item in work_item_results:
        item_id = item.get("work_item_id", "-")
        status = item.get("status", "-")
        verification_goal = item.get("verification_goal_path", "-")
        verification_lines.append(
            f"- `{item_id}`: status={status}, verification_goal=`{verification_goal}`"
        )

    path.write_text(
        "\n".join(
            [
                f"# ChangeSet Completion Report {change_set.change_set_id}",
                "",
                f"- ChangeSet: `{change_set.change_set_id}`",
                f"- Run ID: `{run_id}`",
                "- Status: completed",
                f"- Active path: `{active_path}`",
                f"- Completed path: `{completed_path}`",
                "",
                "## Completed Work Items",
                *work_item_lines,
                "",
                "## Verification",
                *verification_lines,
                "",
            ]
        ),
        encoding="utf-8",
    )
