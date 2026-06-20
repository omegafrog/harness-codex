"""Rollback snapshot and reporting support."""

from __future__ import annotations

import json
import shutil
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
    reverted, preserved, manual, skipped_reason = _apply_rollback_mode(
        context,
        step,
        snapshot,
        changed,
        rollback_mode,
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
        *_markdown_items(reverted),
        "",
        "## Files Preserved",
        "",
        *_markdown_items(preserved),
        "",
        "## Manual Review Required",
        "",
        *_markdown_items(manual),
    ]
    report_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return report_path


def _apply_rollback_mode(
    context: RunContext,
    step: Step,
    snapshot: StepSnapshot,
    changed: tuple[str, ...],
    rollback_mode: str,
) -> tuple[tuple[str, ...], tuple[str, ...], tuple[str, ...], str]:
    if rollback_mode == "none":
        reason = (
            "pre-existing dirty state limits safe rollback"
            if snapshot.dirty_before
            else "default rollback mode preserves files for audit"
        )
        return (), changed, _manual_review(changed, snapshot), reason

    if snapshot.dirty_before:
        return (
            (),
            changed,
            _manual_review(changed, snapshot),
            "rollback skipped because repository was dirty before the failed step",
        )

    if rollback_mode == "safe":
        safe_targets = _planned_output_paths(context, step)
        reverted = tuple(path for path in changed if path in safe_targets)
        for relative in reverted:
            _remove_or_restore_path(context.repo_root, relative)
        preserved = tuple(path for path in changed if path not in set(reverted))
        return (
            reverted,
            preserved,
            preserved,
            "safe rollback reverted only known planned output paths",
        )

    if rollback_mode == "git":
        reverted = tuple(path for path in changed if not _runtime_artifact_path(path))
        for relative in reverted:
            _restore_git_path(context.repo_root, relative)
        preserved = tuple(path for path in changed if path not in set(reverted))
        return (
            reverted,
            preserved,
            preserved,
            "git rollback restored changed repository paths and preserved runtime artifacts",
        )

    return (
        (),
        changed,
        _manual_review(changed, snapshot),
        f"unknown rollback mode `{rollback_mode}` preserves files for audit",
    )


def _planned_output_paths(context: RunContext, step: Step) -> set[str]:
    paths: set[str] = set()
    for output in step.outputs:
        path = output if output.is_absolute() else context.repo_root / output
        try:
            paths.add(str(path.relative_to(context.repo_root)))
        except ValueError:
            continue
    return paths


def _manual_review(changed: tuple[str, ...], snapshot: StepSnapshot) -> tuple[str, ...]:
    if changed:
        return changed
    if snapshot.status_before:
        return tuple(_status_path(line) for line in snapshot.status_before)
    return ("none",)


def _runtime_artifact_path(path: str) -> bool:
    return path == ".harness" or path.startswith(".harness/")


def _remove_or_restore_path(repo_root: Path, relative: str) -> None:
    path = repo_root / relative
    if _is_tracked(repo_root, relative):
        _restore_git_path(repo_root, relative)
        return
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def _restore_git_path(repo_root: Path, relative: str) -> None:
    if _is_tracked(repo_root, relative):
        subprocess.run(
            ("git", "restore", "--staged", "--worktree", "--", relative),
            cwd=repo_root,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return
    path = repo_root / relative
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def _is_tracked(repo_root: Path, relative: str) -> bool:
    completed = subprocess.run(
        ("git", "ls-files", "--error-unmatch", "--", relative),
        cwd=repo_root,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return completed.returncode == 0


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
