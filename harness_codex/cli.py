"""CLI entrypoint for ChangeSet and use-case workflow commands."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from uuid import uuid4

from harness_codex.runtime import (
    ReportWriter,
    ResumeDisposition,
    RunMode,
    RunState,
    RunStateStore,
    RunStatus,
    decide_resume_target,
)
from harness_codex.runtime.changes import (
    ChangeSet,
    ChangeSetResolver,
    NoActiveChangeSetsError,
    PlanningBlocked,
)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    repo_root = Path(args.repo_root)

    try:
        output = args.func(args, repo_root)
    except NoActiveChangeSetsError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if output:
        print(output)

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness")
    parser.add_argument("--repo-root", default=".")
    subparsers = parser.add_subparsers(required=True)

    changes = subparsers.add_parser("changes")
    changes_subparsers = changes.add_subparsers(required=True)
    changes_list = changes_subparsers.add_parser("list")
    changes_list.set_defaults(func=changes_list_command)
    changes_show = changes_subparsers.add_parser("show")
    changes_show.add_argument("change_set_id")
    changes_show.set_defaults(func=changes_show_command)

    run_change = subparsers.add_parser("run-change")
    run_change.add_argument("change_set_id")
    _add_mode_options(run_change)
    run_change.set_defaults(func=run_change_command)

    run_use_case = subparsers.add_parser("run-use-case")
    run_use_case.add_argument("change_set_id")
    run_use_case.add_argument("uc_id")
    _add_mode_options(run_use_case)
    run_use_case.set_defaults(func=run_use_case_command)

    resume = subparsers.add_parser("resume")
    resume.add_argument("run_id")
    resume.set_defaults(func=resume_command)

    report = subparsers.add_parser("report")
    report.add_argument("run_id")
    report.set_defaults(func=report_command)

    return parser


def changes_list_command(args: argparse.Namespace, repo_root: Path) -> str:
    resolver = ChangeSetResolver(repo_root)
    rows = [
        f"{change_set.change_set_id}\t{change_set.status or '-'}\t{change_set.title}"
        for change_set in resolver.list_active()
    ]
    return "\n".join(rows)


def changes_show_command(args: argparse.Namespace, repo_root: Path) -> str:
    change_set = _load_change_set(repo_root, args.change_set_id)
    affected = ", ".join(uc.uc_id for uc in change_set.affected_use_cases) or "-"
    return "\n".join(
        [
            f"ChangeSet: {change_set.change_set_id}",
            f"Status: {change_set.status or '-'}",
            f"Title: {change_set.title}",
            f"Before: {change_set.before_summary or '-'}",
            f"After: {change_set.after_summary or '-'}",
            f"Affected UC: {affected}",
        ]
    )


def run_change_command(args: argparse.Namespace, repo_root: Path) -> str:
    mode = _selected_mode(args)
    change_set = _load_change_set(repo_root, args.change_set_id)
    resolver = ChangeSetResolver(repo_root)
    scopes = resolver.resolve_planning_scopes(change_set)

    if isinstance(scopes, PlanningBlocked):
        return f"BLOCKED: {scopes.reason}"

    if mode in (RunMode.PLAN, RunMode.PREVIEW):
        return _format_scopes(change_set, scopes, mode)

    run_id = _create_run_state(repo_root, change_set, tuple(scope.use_case.uc_id for scope in scopes))
    return f"APPLY started: run_id={run_id}"


def run_use_case_command(args: argparse.Namespace, repo_root: Path) -> str:
    mode = _selected_mode(args)
    change_set = _load_change_set(repo_root, args.change_set_id)
    resolver = ChangeSetResolver(repo_root)
    scopes = resolver.resolve_planning_scopes(change_set)

    if isinstance(scopes, PlanningBlocked):
        return f"BLOCKED: {scopes.reason}"

    selected = tuple(scope for scope in scopes if scope.use_case.uc_id == args.uc_id)
    if not selected:
        return f"BLOCKED: {args.uc_id} is not affected by {change_set.change_set_id}"

    if mode in (RunMode.PLAN, RunMode.PREVIEW):
        return _format_scopes(change_set, selected, mode)

    run_id = _create_run_state(repo_root, change_set, (args.uc_id,))
    return f"APPLY started: run_id={run_id} uc_id={args.uc_id}"


def resume_command(args: argparse.Namespace, repo_root: Path) -> str:
    state = RunStateStore(repo_root).load(args.run_id)
    target = decide_resume_target(state)
    if target.disposition == ResumeDisposition.COMPLETE:
        return f"COMPLETE: {target.reason}"
    return "\n".join(
        [
            f"Resume: {target.disposition.value}",
            f"UC: {target.uc_id or '-'}",
            f"Step: {target.step_id.value if target.step_id else '-'}",
            f"Reason: {target.reason}",
        ]
    )


def report_command(args: argparse.Namespace, repo_root: Path) -> str:
    report_path = repo_root / ".harness/runs" / args.run_id / "report.md"
    if not report_path.exists():
        manifest = ReportWriter(repo_root).artifact_manifest(args.run_id, ())
        return f"Report not found. Expected: {manifest.run_report_md}"
    return report_path.read_text(encoding="utf-8").strip()


def _load_change_set(repo_root: Path, change_set_id: str) -> ChangeSet:
    return ChangeSetResolver(repo_root).load(
        Path("docs/changes/active") / f"{change_set_id}.md"
    )


def _selected_mode(args: argparse.Namespace) -> RunMode:
    if args.plan:
        return RunMode.PLAN
    if args.preview:
        return RunMode.PREVIEW
    return RunMode.APPLY


def _add_mode_options(parser: argparse.ArgumentParser) -> None:
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--plan", action="store_true")
    mode.add_argument("--preview", action="store_true")
    mode.add_argument("--apply", action="store_true")


def _format_scopes(
    change_set: ChangeSet,
    scopes: tuple,
    mode: RunMode,
) -> str:
    lines = [
        f"Mode: {mode.value}",
        f"ChangeSet: {change_set.change_set_id}",
        "Side effects: false",
    ]

    for scope in scopes:
        lines.extend(
            [
                f"UC: {scope.use_case.uc_id}",
                "Planner inputs:",
                *[f"- {path}" for path in scope.planner_inputs],
                "Executor inputs:",
                *[f"- {path}" for path in scope.executor_inputs],
            ]
        )

    return "\n".join(lines)


def _create_run_state(
    repo_root: Path,
    change_set: ChangeSet,
    affected_use_cases: tuple[str, ...],
) -> str:
    run_id = f"run-{uuid4().hex[:12]}"
    state = RunState(
        run_id=run_id,
        change_set_id=change_set.change_set_id,
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        affected_use_cases=affected_use_cases,
        current_use_case_id=affected_use_cases[0] if affected_use_cases else None,
        status=RunStatus.PENDING,
    )
    RunStateStore(repo_root).save(state)
    return run_id


if __name__ == "__main__":
    raise SystemExit(main())
