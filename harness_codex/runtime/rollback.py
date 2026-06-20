"""Rollback snapshot and reporting support."""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from harness_codex.runtime.models import RunContext, Step, StepResult


@dataclass(frozen=True)
class StepSnapshot:
    step_id: str
    snapshot_dir: Path
    dirty_before: bool
    status_before: tuple[str, ...]


def capture_pre_step_snapshot(
    context: RunContext,
    step: Step,
) -> StepSnapshot:
    snapshot_dir = context.repo_root / ".harness/runs" / context.run_id / "snapshots" / step.id
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    status = _git_lines(context.repo_root, ("status", "--porcelain=v1"))
    diff = _git_text(context.repo_root, ("diff", "--binary"))
    tracked = _git_lines(context.repo_root, ("ls-files",))
    planned_outputs = tuple(str(path) for path in step.outputs)
    (snapshot_dir / "git-status-before.txt").write_text(
        "\n".join(status) + ("\n" if status else ""),
        encoding="utf-8",
    )
    (snapshot_dir / "git-diff-before.patch").write_text(diff, encoding="utf-8")
    (snapshot_dir / "tracked-files.json").write_text(
        json.dumps(list(tracked), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    (snapshot_dir / "planned-output-paths.json").write_text(
        json.dumps(list(planned_outputs), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return StepSnapshot(
        step_id=step.id,
        snapshot_dir=snapshot_dir,
        dirty_before=bool(status),
        status_before=tuple(status),
    )


def write_rollback_report(
    context: RunContext,
    step: Step,
    result: StepResult,
    snapshot: StepSnapshot,
) -> Path:
    current_status = _git_lines(context.repo_root, ("status", "--porcelain=v1"))
    changed = _changed_paths_since_snapshot(snapshot.status_before, current_status)
    report_path = context.repo_root / ".harness/runs" / context.run_id / "rollback-report.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    rollback_mode = str(context.metadata.get("rollback_mode") or "none")
    skipped_reason = (
        "pre-existing dirty state limits safe rollback"
        if snapshot.dirty_before
        else "default rollback mode preserves files for audit"
    )
    lines = [
        "# Rollback Report",
        "",
        f"- Run ID: `{context.run_id}`",
        f"- ChangeSet ID: `{context.metadata.get('change_set_id', '')}`",
        f"- Work item ID: `{context.metadata.get('active_work_item_id', '')}`",
        f"- Failed step ID: `{step.id}`",
        f"- Step status: `{result.status.value}`",
        f"- Rollback mode: `{rollback_mode}`",
        f"- Rollback skipped: `{skipped_reason}`",
        f"- Snapshot: `{snapshot.snapshot_dir.relative_to(context.repo_root)}`",
        "",
        "## Files Changed During Failed Step",
        "",
        *_markdown_items(changed),
        "",
        "## Pre-existing Dirty State",
        "",
        *_markdown_items(_status_path(line) for line in snapshot.status_before),
        "",
        "## Files Reverted",
        "",
        "- none",
        "",
        "## Files Preserved",
        "",
        *_markdown_items(changed),
        "",
        "## Manual Review Required",
        "",
        *_markdown_items(changed if snapshot.dirty_before or changed else ("none",)),
    ]
    report_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return report_path


def _changed_paths_since_snapshot(
    before: Iterable[str],
    after: Iterable[str],
) -> tuple[str, ...]:
    before_paths = {_status_path(line) for line in before}
    after_paths = {_status_path(line) for line in after}
    changed = tuple(sorted(path for path in after_paths - before_paths if path))
    return changed or tuple(sorted(path for path in after_paths if path))


def _status_path(line: str) -> str:
    value = line[3:] if len(line) > 3 else line
    if " -> " in value:
        value = value.split(" -> ", maxsplit=1)[1]
    return value.strip()


def _markdown_items(items: Iterable[str]) -> list[str]:
    materialized = [item for item in items if item]
    if not materialized:
        return ["- none"]
    return [f"- `{item}`" for item in materialized]


def _git_lines(repo_root: Path, args: tuple[str, ...]) -> tuple[str, ...]:
    text = _git_text(repo_root, args)
    return tuple(line for line in text.splitlines() if line.strip())


def _git_text(repo_root: Path, args: tuple[str, ...]) -> str:
    completed = subprocess.run(
        ("git", *args),
        cwd=repo_root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return completed.stdout if completed.returncode == 0 else ""
