"""CLI entrypoint for ChangeSet and use-case workflow commands."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from uuid import uuid4

from harness_codex.runtime import (
    BasicStepRunner,
    ReportWriter,
    ResumeDisposition,
    RunContext,
    RunFailureKind,
    RunMode,
    RunReport,
    RunState,
    RunStateStore,
    RunStatus,
    UseCaseLoopState,
    WorkItemLoopRunner,
    WorkItemLoopState,
    WorkItemReport,
    decide_resume_target,
)
from harness_codex.runtime.dashboard import dashboard_state_json
from harness_codex.runtime.changes import (
    ChangeSet,
    ChangeSetResolver,
    NoActiveChangeSetsError,
    PlanningBlocked,
)
from harness_codex.runtime.workflows import load_named_workflow


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

    run_work_item = subparsers.add_parser("run-work-item")
    run_work_item.add_argument("change_set_id")
    run_work_item.add_argument("work_item_id")
    _add_mode_options(run_work_item)
    run_work_item.set_defaults(func=run_work_item_command)

    stages = subparsers.add_parser("stages")
    stages_subparsers = stages.add_subparsers(required=True)
    stages_list = stages_subparsers.add_parser("list")
    stages_list.add_argument("change_set_id")
    stages_list.set_defaults(func=stages_list_command)

    artifacts = subparsers.add_parser("artifacts")
    artifacts_subparsers = artifacts.add_subparsers(required=True)
    artifacts_show = artifacts_subparsers.add_parser("show")
    artifacts_show.add_argument("change_set_id")
    artifacts_show.add_argument("stage")
    artifacts_show.set_defaults(func=artifacts_show_command)
    artifacts_accept = artifacts_subparsers.add_parser("accept")
    artifacts_accept.add_argument("change_set_id")
    artifacts_accept.add_argument("stage")
    artifacts_accept.set_defaults(func=artifacts_accept_command)

    run_stage = subparsers.add_parser("run-stage")
    run_stage.add_argument("change_set_id")
    run_stage.add_argument("stage")
    _add_mode_options(run_stage)
    run_stage.set_defaults(func=run_stage_command)

    resume = subparsers.add_parser("resume")
    resume.add_argument("run_id")
    resume.set_defaults(func=resume_command)

    report = subparsers.add_parser("report")
    report.add_argument("run_id")
    report.set_defaults(func=report_command)

    dashboard = subparsers.add_parser("dashboard")
    dashboard.set_defaults(func=dashboard_command)

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
    work_items = ", ".join(
        f"{item.work_item_id}({item.work_item_type.value})"
        for item in change_set.ordered_work_items()
    ) or "-"
    return "\n".join(
        [
            f"ChangeSet: {change_set.change_set_id}",
            f"Status: {change_set.status or '-'}",
            f"Title: {change_set.title}",
            f"Before: {change_set.before_summary or '-'}",
            f"After: {change_set.after_summary or '-'}",
            f"Affected UC: {affected}",
            f"Work items: {work_items}",
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

    state, result = _apply_workflow(repo_root, change_set, scopes)
    return _format_apply_result(state, result)


def run_use_case_command(args: argparse.Namespace, repo_root: Path) -> str:
    mode = _selected_mode(args)
    change_set = _load_change_set(repo_root, args.change_set_id)
    resolver = ChangeSetResolver(repo_root)
    scopes = resolver.resolve_planning_scopes(change_set)

    if isinstance(scopes, PlanningBlocked):
        return f"BLOCKED: {scopes.reason}"

    selected = tuple(
        scope
        for scope in scopes
        if scope.use_case is not None and scope.use_case.uc_id == args.uc_id
    )
    if not selected:
        return f"BLOCKED: {args.uc_id} is not affected by {change_set.change_set_id}"

    if mode in (RunMode.PLAN, RunMode.PREVIEW):
        return _format_scopes(change_set, selected, mode)

    state, result = _apply_workflow(repo_root, change_set, selected)
    return _format_apply_result(state, result, selected_id=args.uc_id)


def run_work_item_command(args: argparse.Namespace, repo_root: Path) -> str:
    mode = _selected_mode(args)
    change_set = _load_change_set(repo_root, args.change_set_id)
    resolver = ChangeSetResolver(repo_root)
    scopes = resolver.resolve_work_item_scopes(change_set)

    if isinstance(scopes, PlanningBlocked):
        return f"BLOCKED: {scopes.reason}"

    selected = tuple(scope for scope in scopes if scope.display_id == args.work_item_id)
    if not selected:
        return f"BLOCKED: {args.work_item_id} is not affected by {change_set.change_set_id}"

    if mode in (RunMode.PLAN, RunMode.PREVIEW):
        return _format_scopes(change_set, selected, mode)

    state, result = _apply_workflow(repo_root, change_set, selected)
    return _format_apply_result(state, result, selected_id=args.work_item_id)


def stages_list_command(args: argparse.Namespace, repo_root: Path) -> str:
    run_id = _latest_run_id_for_change_set(repo_root, args.change_set_id)
    if run_id is None:
        return "No run state found"
    state = RunStateStore(repo_root).load(run_id)
    rows = [
        f"{item.stage}\t{item.path}\taccepted={item.accepted}\tdirty={item.dirty_state.value}\tdownstream={item.downstream_status.value}"
        for item in state.artifact_states
    ]
    return "\n".join(rows) if rows else "No stage artifacts recorded"


def artifacts_show_command(args: argparse.Namespace, repo_root: Path) -> str:
    run_id = _latest_run_id_for_change_set(repo_root, args.change_set_id)
    if run_id is None:
        return "No run state found"
    state = RunStateStore(repo_root).load(run_id)
    for item in state.artifact_states:
        if item.stage == args.stage:
            return "\n".join(
                [
                    f"Stage: {item.stage}",
                    f"Path: {item.path}",
                    f"Revision: {item.revision}",
                    f"Checksum: {item.checksum or '-'}",
                    f"Accepted: {item.accepted}",
                    f"Dirty: {item.dirty_state.value}",
                    f"Downstream: {item.downstream_status.value}",
                ]
            )
    return f"Stage artifact not found: {args.stage}"


def artifacts_accept_command(args: argparse.Namespace, repo_root: Path) -> str:
    run_id = _latest_run_id_for_change_set(repo_root, args.change_set_id)
    if run_id is None:
        return "No run state found"
    path = _stage_default_path(args.change_set_id, args.stage)
    RunStateStore(repo_root).save_artifact_acceptance(run_id, args.stage, path)
    return f"ACCEPTED: run_id={run_id} stage={args.stage} path={path}"


def run_stage_command(args: argparse.Namespace, repo_root: Path) -> str:
    mode = _selected_mode(args)
    run_id = _latest_run_id_for_change_set(repo_root, args.change_set_id)
    if run_id is None:
        return "No run state found"
    if mode in (RunMode.PLAN, RunMode.PREVIEW):
        return f"Mode: {mode.value}\nStage: {args.stage}\nSide effects: false"
    state = RunStateStore(repo_root).save_artifact_acceptance(
        run_id,
        args.stage,
        _stage_default_path(args.change_set_id, args.stage),
        generated_by="runtime",
    )
    return f"STAGE applied: run_id={state.run_id} stage={args.stage}"


def resume_command(args: argparse.Namespace, repo_root: Path) -> str:
    state = RunStateStore(repo_root).load(args.run_id)
    target = decide_resume_target(state)
    if target.disposition == ResumeDisposition.COMPLETE:
        return f"COMPLETE: {target.reason}"
    return "\n".join(
        [
            f"Resume: {target.disposition.value}",
            f"UC: {target.uc_id or '-'}",
            f"Work item: {target.work_item_id or '-'}",
            f"Type: {target.work_item_type.value if target.work_item_type else '-'}",
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


def dashboard_command(args: argparse.Namespace, repo_root: Path) -> str:
    return dashboard_state_json(repo_root).strip()


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
                f"Work item: {scope.display_id}",
                f"Type: {scope.work_item_type.value}",
                f"UC: {scope.use_case.uc_id if scope.use_case else '-'}",
                f"Plan: {scope.plan_path or '-'}",
                f"Stage: {scope.current_stage}",
                "Planner inputs:",
                *[f"- {path}" for path in scope.planner_inputs],
                "Executor inputs:",
                *[f"- {path}" for path in scope.executor_inputs],
            ]
        )

    return "\n".join(lines)


def _format_apply_result(
    state: RunState,
    result,
    *,
    selected_id: str | None = None,
) -> str:
    lines = [
        f"APPLY started: run_id={state.run_id} status={result.status.value}",
        f"Report: .harness/runs/{state.run_id}/report.md",
        f"State: .harness/runs/{state.run_id}/state.json",
    ]
    if selected_id:
        lines.append(f"Selected: {selected_id}")
    lines.extend(
        [
            f"Completed work items: {', '.join(state.completed_work_items) or '-'}",
            f"Blocked work items: {', '.join(state.blocked_work_items) or '-'}",
        ]
    )
    if state.failed_step_id:
        lines.append(f"Failed step: {state.failed_step_id}")
    if state.failure_kind:
        lines.append(f"Failure kind: {state.failure_kind.value}")
    blocker = _first_blocker(result)
    if blocker:
        lines.append(f"Blocker: {blocker}")
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


def _apply_workflow(
    repo_root: Path,
    change_set: ChangeSet,
    scopes: tuple,
):
    run_id = f"run-{uuid4().hex[:12]}"
    affected_use_cases = tuple(
        scope.use_case.uc_id for scope in scopes if scope.use_case is not None
    )
    affected_work_items = tuple(scope.display_id for scope in scopes)
    run_dir = repo_root / ".harness/runs" / run_id
    workflow_dir = repo_root / ".harness/workflows"
    if not (workflow_dir / "changeset-use-case-workflow.yaml").exists():
        workflow_dir = Path(__file__).resolve().parents[1] / ".harness/workflows"
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=workflow_dir,
    )
    context = RunContext(
        run_id=run_id,
        workflow_name=workflow.name,
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=run_dir,
        metadata={
            "change_set_id": change_set.change_set_id,
            "change_set_path": str(
                change_set.path
                or Path(f"docs/changes/active/{change_set.change_set_id}.md")
            ),
            "affected_work_items": [
                {
                    "id": scope.display_id,
                    "type": scope.work_item_type.value,
                    "plan_path": str(
                        scope.plan_path
                        or Path(f"docs/plans/active/{scope.display_id}/plan.md")
                    ),
                    "planner_inputs": [
                        str(path) for path in scope.planner_inputs
                    ],
                    "executor_inputs": [
                        str(path) for path in scope.executor_inputs
                    ],
                    "verification_goal_path": (
                        str(scope.verification_goal_path)
                        if scope.verification_goal_path
                        else None
                    ),
                }
                for scope in scopes
            ],
        },
    )
    result = WorkItemLoopRunner(
        step_runner=BasicStepRunner(),
        workflow=workflow,
    ).run(change_set=change_set, scopes=scopes, context=context)
    item_results_by_id = {
        item_result.scope.display_id: item_result
        for item_result in result.item_results
    }
    completed_use_cases = tuple(
        item_id
        for item_id in result.completed_work_items
        if any(scope.use_case is not None and scope.display_id == item_id for scope in scopes)
    )
    blocked_use_cases = tuple(
        item_id
        for item_id in result.blocked_work_items
        if any(scope.use_case is not None and scope.display_id == item_id for scope in scopes)
    )
    state = RunState(
        run_id=run_id,
        change_set_id=change_set.change_set_id,
        workflow_name=workflow.name,
        mode=RunMode.APPLY,
        affected_use_cases=affected_use_cases,
        affected_work_items=affected_work_items,
        current_use_case_id=affected_use_cases[0] if affected_use_cases else None,
        current_work_item_id=affected_work_items[0] if affected_work_items else None,
        status=result.status,
        completed_use_cases=completed_use_cases,
        completed_work_items=result.completed_work_items,
        blocked_use_cases=blocked_use_cases,
        blocked_work_items=result.blocked_work_items,
        failure_kind=_first_failure_kind(result),
        work_item_states=tuple(
            WorkItemLoopState(
                work_item_id=scope.display_id,
                work_item_type=scope.work_item_type,
                active_plan_path=scope.plan_path or Path(f"docs/plans/active/{scope.display_id}/plan.md"),
                status=item_results_by_id.get(scope.display_id).status if scope.display_id in item_results_by_id else RunStatus.PENDING,
                current_step_id=item_results_by_id.get(scope.display_id).current_stage if scope.display_id in item_results_by_id else scope.current_stage,
                verification_status=item_results_by_id.get(scope.display_id).verification_status if scope.display_id in item_results_by_id else "",
                retry_count=item_results_by_id.get(scope.display_id).retry_count if scope.display_id in item_results_by_id else 0,
                failure_kind=_item_failure_kind(item_results_by_id.get(scope.display_id)),
                blocker=item_results_by_id.get(scope.display_id).blocker if scope.display_id in item_results_by_id else None,
            )
            for scope in scopes
        ),
        use_case_states=tuple(
            UseCaseLoopState(
                uc_id=scope.use_case.uc_id,
                active_plan_path=scope.plan_path or Path(f"docs/plans/active/{scope.use_case.uc_id}/plan.md"),
                status=item_results_by_id.get(scope.display_id).status if scope.display_id in item_results_by_id else RunStatus.PENDING,
                current_step_id=item_results_by_id.get(scope.display_id).current_stage if scope.display_id in item_results_by_id else scope.current_stage,
                verification_status=item_results_by_id.get(scope.display_id).verification_status if scope.display_id in item_results_by_id else "",
                retry_count=item_results_by_id.get(scope.display_id).retry_count if scope.display_id in item_results_by_id else 0,
                failure_kind=_item_failure_kind(item_results_by_id.get(scope.display_id)),
                blocker=item_results_by_id.get(scope.display_id).blocker if scope.display_id in item_results_by_id else None,
            )
            for scope in scopes
            if scope.use_case is not None
        ),
        failed_step_id=_first_failed_step_id(result),
    )
    RunStateStore(repo_root).save(state)
    ReportWriter(repo_root).write(
        RunReport(
            run_id=run_id,
            change_set_id=change_set.change_set_id,
            workflow_name=workflow.name,
            mode=RunMode.APPLY,
            status=result.status,
            affected_use_cases=affected_use_cases,
            completed_use_cases=completed_use_cases,
            blocked_use_cases=blocked_use_cases,
            completed_work_items=result.completed_work_items,
            failed_work_items=result.failed_work_items,
            blocked_work_items=result.blocked_work_items,
            current_use_case_id=affected_use_cases[0] if affected_use_cases else None,
            work_item_reports=tuple(
                WorkItemReport(
                    work_item_id=scope.display_id,
                    work_item_type=scope.work_item_type,
                    active_plan_path=scope.plan_path or Path(f"docs/plans/active/{scope.display_id}/plan.md"),
                    status=item_results_by_id.get(scope.display_id).status if scope.display_id in item_results_by_id else RunStatus.PENDING,
                    current_stage=item_results_by_id.get(scope.display_id).current_stage if scope.display_id in item_results_by_id else scope.current_stage,
                    completed_plan_path=item_results_by_id.get(scope.display_id).completed_plan_path if scope.display_id in item_results_by_id else None,
                    verification_goal_path=scope.verification_goal_path,
                    blocker=item_results_by_id.get(scope.display_id).blocker if scope.display_id in item_results_by_id else None,
                    verification_result=item_results_by_id.get(scope.display_id).verification_status if scope.display_id in item_results_by_id else "",
                )
                for scope in scopes
            ),
        )
    )
    return state, result


def _first_failed_step_id(result) -> str | None:
    for item_result in result.item_results:
        if item_result.failed_step_id:
            return item_result.failed_step_id
    return None


def _first_blocker(result) -> str | None:
    for item_result in result.item_results:
        if item_result.blocker:
            return item_result.blocker
    return None


def _first_failure_kind(result) -> RunFailureKind | None:
    for item_result in result.item_results:
        failure_kind = _item_failure_kind(item_result)
        if failure_kind is not None:
            return failure_kind
    return None


def _item_failure_kind(item_result) -> RunFailureKind | None:
    if item_result is None or item_result.failure_kind is None:
        return None
    if item_result.failure_kind.value == "implementation":
        return RunFailureKind.IMPLEMENTATION_FAILURE
    if item_result.failure_kind.value == "upstream_design":
        return RunFailureKind.UPSTREAM_DESIGN_CONFLICT
    if item_result.failure_kind.value == "environment_blocker":
        return RunFailureKind.ENVIRONMENT_BLOCKER
    return None


def _latest_run_id_for_change_set(repo_root: Path, change_set_id: str) -> str | None:
    runs_dir = repo_root / ".harness/runs"
    if not runs_dir.exists():
        return None
    candidates = []
    for state_path in runs_dir.glob("*/state.json"):
        state = RunStateStore(repo_root).load(state_path.parent.name)
        if state.change_set_id == change_set_id:
            candidates.append((state_path.stat().st_mtime, state.run_id))
    if not candidates:
        return None
    return sorted(candidates)[-1][1]


def _stage_default_path(change_set_id: str, stage: str) -> Path:
    if stage in {"requirements", "use_cases"}:
        return Path("docs/design") / f"{stage}.md"
    if stage == "change_set":
        return Path("docs/changes/active") / f"{change_set_id}.md"
    return Path(".harness/stages") / change_set_id / f"{stage}.md"


if __name__ == "__main__":
    raise SystemExit(main())
