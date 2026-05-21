"""CLI entrypoint for ChangeSet and use-case workflow commands."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from uuid import uuid4

from harness_codex.runtime import (
    AGENT_CONTEXT_FILES,
    AgentContextBootstrapResult,
    BasicStepRunner,
    ReportWriter,
    ResumeDisposition,
    RunnerEngine,
    RunContext,
    RunMode,
    RunReport,
    RunState,
    RunStateStore,
    RunStatus,
    StageArtifactState,
    UseCaseLoopState,
    WorkItemLoopState,
    WorkItemReport,
    bootstrap_agent_context,
    decide_resume_target,
    file_checksum,
)
from harness_codex.runtime.changes import (
    ChangeSet,
    ChangeSetResolver,
    DesignBridgeError,
    NoActiveChangeSetsError,
    PlanningBlocked,
    create_changeset_from_design,
)
from harness_codex.runtime.dashboard import dashboard_state_json
from harness_codex.runtime.interactive_harvest import (
    list_harvest_sessions,
    run_interactive_harvest,
)
from harness_codex.runtime.ui_server import run_ui_server
from harness_codex.runtime.workflows import (
    WorkflowMaterializationError,
    load_named_workflow,
    materialize_workflow_for_scope,
    write_materialized_workflow_manifest,
)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    repo_root = Path(args.repo_root)

    try:
        output = args.func(args, repo_root)
    except (
        NoActiveChangeSetsError,
        DesignBridgeError,
        WorkflowMaterializationError,
        ValueError,
    ) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if output:
        print(output)

    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="harness")
    parser.add_argument("--repo-root", default=".")
    subparsers = parser.add_subparsers(required=True)

    harvest = subparsers.add_parser(
        "harvest",
        description="Harvest a product idea into canonical design documents.",
        epilog=(
            "Examples:\n"
            "  harness harvest --idea '<feature idea>' --plan\n"
            "  harness harvest --idea '<feature idea>' --interactive --session-id harvest-001\n"
            "  harness harvest --interactive --session-id harvest-001 --resume\n"
            "  harness harvest sessions"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    harvest.add_argument(
        "--idea",
        default="",
        help="Initial product or feature idea to harvest into requirements and use-case design documents.",
    )
    harvest.add_argument(
        "--session-id",
        default="",
        help="Harvest session id. Use with --interactive to start or resume a named session.",
    )
    harvest.add_argument(
        "--resume",
        action="store_true",
        help="Resume an existing harvest session selected by --session-id.",
    )
    harvest.add_argument(
        "harvest_subcommand",
        nargs="?",
        choices=("sessions",),
        help="Harvest utility command. Use `sessions` to list interactive harvest sessions.",
    )
    _add_harvest_mode_options(harvest)
    harvest.set_defaults(func=harvest_command)

    agent_context = subparsers.add_parser("agent-context")
    agent_context_subparsers = agent_context.add_subparsers(required=True)
    agent_context_init = agent_context_subparsers.add_parser("init")
    agent_context_init.add_argument("--description", default="")
    agent_context_init.add_argument("--force", action="store_true")
    agent_context_init.set_defaults(func=agent_context_init_command)

    changes = subparsers.add_parser("changes")
    changes_subparsers = changes.add_subparsers(required=True)
    changes_list = changes_subparsers.add_parser("list")
    changes_list.set_defaults(func=changes_list_command)
    changes_active = changes_subparsers.add_parser("active")
    changes_active.set_defaults(func=changes_active_command)
    changes_show = changes_subparsers.add_parser("show")
    changes_show.add_argument("change_set_id")
    changes_show.set_defaults(func=changes_show_command)
    changes_create_from_design = changes_subparsers.add_parser("create-from-design")
    changes_create_from_design.add_argument("--title", required=True)
    changes_create_from_design.add_argument("--change-set-id")
    changes_create_from_design.add_argument("--related-issue", default="")
    changes_create_from_design.add_argument(
        "--uc",
        action="append",
        default=[],
        help="Limit generated slices to one canonical use case. May be passed more than once.",
    )
    changes_create_from_design.add_argument("--force", action="store_true")
    changes_create_from_design.set_defaults(func=changes_create_from_design_command)

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

    ui_server = subparsers.add_parser("ui-server")
    ui_server.add_argument("--host", default="127.0.0.1")
    ui_server.add_argument("--port", type=int, default=8765)
    ui_server.set_defaults(func=ui_server_command)

    return parser


def harvest_command(args: argparse.Namespace, repo_root: Path) -> str:
    if getattr(args, "harvest_subcommand", "") == "sessions":
        return list_harvest_sessions(repo_root)

    if not any((args.plan, args.preview, args.apply, args.interactive)):
        raise ValueError(
            "harvest requires one of --plan or --interactive, "
            "or the sessions subcommand"
        )

    _warn_harvest_mode_aliases(args)

    workflow_dir = repo_root / ".harness/workflows"
    if not (workflow_dir / "harvest-workflow.yaml").exists():
        workflow_dir = Path(__file__).resolve().parents[1] / ".harness/workflows"
    workflow = load_named_workflow("harvest-workflow", workflows_dir=workflow_dir)

    mode = _selected_mode(args)
    if mode in (RunMode.PLAN, RunMode.PREVIEW):
        return _format_harvest_plan(workflow, mode, args.idea)

    agent_context = bootstrap_agent_context(repo_root, _repo_description(args.idea))
    return "\n".join(
        [
            run_interactive_harvest(
                repo_root,
                args.idea,
                session_id=args.session_id,
                resume=args.resume,
            ),
            _format_agent_context_result(agent_context),
        ]
    )


def agent_context_init_command(args: argparse.Namespace, repo_root: Path) -> str:
    result = bootstrap_agent_context(
        repo_root,
        _repo_description(args.description),
        force=args.force,
    )
    return _format_agent_context_result(result)


def changes_list_command(args: argparse.Namespace, repo_root: Path) -> str:
    resolver = ChangeSetResolver(repo_root)
    rows = [
        f"{change_set.change_set_id}\t{change_set.status or '-'}\t{change_set.title}"
        for change_set in resolver.list_active()
    ]
    return "\n".join(rows)


def changes_active_command(args: argparse.Namespace, repo_root: Path) -> str:
    resolver = ChangeSetResolver(repo_root)
    rows: list[str] = []
    for change_set in resolver.list_active():
        rows.extend(_format_active_change_set(repo_root, resolver, change_set))
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


def changes_create_from_design_command(args: argparse.Namespace, repo_root: Path) -> str:
    result = create_changeset_from_design(
        repo_root,
        title=args.title,
        change_set_id=args.change_set_id,
        related_issue=args.related_issue,
        selected_use_cases=tuple(args.uc),
        force=args.force,
    )
    agent_context = bootstrap_agent_context(repo_root, _repo_description(args.title))
    lines = [
        f"CREATED: {result.change_set_id}",
        f"ChangeSet: {result.change_set_path}",
        "Affected use cases:",
        *[f"- {use_case.uc_id}: {use_case.name}" for use_case in result.use_cases],
        "Created documents:",
        *[f"- {path}" for path in result.created_paths],
        _format_agent_context_result(agent_context),
    ]
    return "\n".join(lines)


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
    return f"APPLY started: run_id={state.run_id} status={result.status.value}"


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
    return f"APPLY started: run_id={state.run_id} uc_id={args.uc_id} status={result.status.value}"


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
    return f"APPLY started: run_id={state.run_id} work_item_id={args.work_item_id} status={result.status.value}"


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


def ui_server_command(args: argparse.Namespace, repo_root: Path) -> str:
    run_ui_server(repo_root, host=args.host, port=args.port)
    return ""


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


def _add_harvest_mode_options(parser: argparse.ArgumentParser) -> None:
    mode = parser.add_mutually_exclusive_group(required=False)
    mode.add_argument(
        "--plan",
        action="store_true",
        help="Show the harvest workflow plan without changing files. Debug/explain mode only.",
    )
    mode.add_argument("--preview", action="store_true", help=argparse.SUPPRESS)
    mode.add_argument("--apply", action="store_true", help=argparse.SUPPRESS)
    mode.add_argument(
        "--interactive",
        action="store_true",
        help="Run the interactive Grill-Me loop and generate design documents.",
    )


def _warn_harvest_mode_aliases(args: argparse.Namespace) -> None:
    if args.preview:
        print(
            "warning: `harvest --preview` is deprecated; use `harvest --plan`.",
            file=sys.stderr,
        )
    if args.apply:
        print(
            "warning: `harvest --apply` is deprecated; use `harvest --interactive`.",
            file=sys.stderr,
        )


def _format_scopes(change_set: ChangeSet, scopes: tuple, mode: RunMode) -> str:
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
                f"Verification goal: {scope.verification_goal_path or '-'}",
            ]
        )

    return "\n".join(lines)


def _format_active_change_set(
    repo_root: Path,
    resolver: ChangeSetResolver,
    change_set: ChangeSet,
) -> list[str]:
    latest_run_id = _latest_run_id_for_change_set(repo_root, change_set.change_set_id)
    blocked = resolver.validate_active_change_set(change_set)
    scopes = resolver.resolve_work_item_scopes(change_set) if blocked is None else blocked
    lines = [
        f"ChangeSet: {change_set.change_set_id}",
        f"Title: {change_set.title}",
        f"Status: {change_set.status or 'active'}",
        f"Path: {change_set.path or Path('docs/changes/active') / f'{change_set.change_set_id}.md'}",
        f"Latest run: {latest_run_id or '-'}",
    ]
    if isinstance(scopes, PlanningBlocked):
        lines.append(f"Runtime status: BLOCKED - {scopes.reason}")
        return lines

    lines.append("Runtime status: READY")
    lines.append("Work items:")
    for scope in scopes:
        lines.extend(
            [
                f"- {scope.display_id} ({scope.work_item_type.value})",
                f"  stage: {scope.current_stage}",
                f"  plan: {scope.plan_path or '-'}",
                f"  verification goal: {scope.verification_goal_path or '-'}",
            ]
        )
    return lines


def _format_harvest_plan(workflow, mode: RunMode, idea: str) -> str:
    lines = [
        f"Mode: {mode.value}",
        f"Workflow: {workflow.name}",
        "Side effects: false",
        f"Idea: {idea or '-'}",
        "Agent context bootstrap:",
        *[f"- {path}" for path in AGENT_CONTEXT_FILES],
    ]
    for step in RunnerEngine(BasicStepRunner()).plan(workflow).steps:
        lines.extend(
            [
                f"Step: {step.id}",
                f"Kind: {step.kind.value}",
                f"Agent: {step.agent_id or '-'}",
                "Outputs:",
                *[f"- {path}" for path in step.outputs],
            ]
        )
    return "\n".join(lines)


def _format_agent_context_result(result: AgentContextBootstrapResult) -> str:
    lines = [
        "Agent context:",
        f"- baseline AGENTS.md words: {result.baseline_agent_words}",
        f"- final AGENTS.md words: {result.final_agent_words}",
    ]
    lines.extend(f"- {item.path}: {item.action}" for item in result.files)
    return "\n".join(lines)


def _repo_description(value: str) -> str:
    text = value.strip()
    if text:
        return text
    return "Repository managed by the harness workflow."


def _apply_harvest_workflow(repo_root: Path, workflow, idea: str):
    run_id = f"run-{uuid4().hex[:12]}"
    run_dir = repo_root / ".harness/runs" / run_id
    context = RunContext(
        run_id=run_id,
        workflow_name=workflow.name,
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=run_dir,
        metadata={
            "stage": "harvest",
            "initial_idea": idea,
            "required_outputs": [
                "docs/design/요구사항.md",
                "docs/design/유스케이스.md",
            ],
            "next_runtime_step": "changes create-from-design",
        },
    )
    result = RunnerEngine(BasicStepRunner()).run(workflow, context)
    artifact_states = tuple(
        _harvest_artifact_state(repo_root, stage, path)
        for stage, path in (
            ("requirements", Path("docs/design/요구사항.md")),
            ("use_cases", Path("docs/design/유스케이스.md")),
        )
    )
    state = RunState(
        run_id=run_id,
        change_set_id="HARVEST",
        workflow_name=workflow.name,
        mode=RunMode.APPLY,
        affected_use_cases=(),
        affected_work_items=(),
        status=result.status,
        failed_step_id=result.failed_step_id,
        artifact_states=artifact_states,
    )
    RunStateStore(repo_root).save(state)
    ReportWriter(repo_root).write(
        RunReport(
            run_id=run_id,
            change_set_id="HARVEST",
            workflow_name=workflow.name,
            mode=RunMode.APPLY,
            status=result.status,
            affected_use_cases=(),
            artifact_paths={
                stage: item.path
                for stage, item in zip(("requirements", "use_cases"), artifact_states)
            },
        )
    )
    return state, result


def _harvest_artifact_state(repo_root: Path, stage: str, path: Path) -> StageArtifactState:
    absolute_path = repo_root / path
    checksum = file_checksum(absolute_path) if absolute_path.exists() else ""
    return StageArtifactState(
        stage=stage,
        path=path,
        checksum=checksum,
        revision=1 if checksum else 0,
        generated_by="runtime",
        accepted=False,
    )


def _apply_workflow(repo_root: Path, change_set: ChangeSet, scopes: tuple):
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

    result_by_work_item = {}
    final_result = None
    for scope in scopes:
        materialized_workflow = materialize_workflow_for_scope(workflow, change_set, scope)
        write_materialized_workflow_manifest(
            materialized_workflow,
            run_dir / f"materialized-workflow-{scope.display_id}.json",
        )
        context = RunContext(
            run_id=run_id,
            workflow_name=materialized_workflow.name,
            mode=RunMode.APPLY,
            repo_root=repo_root,
            workdir=repo_root,
            run_dir=run_dir / scope.display_id,
            metadata={
                "change_set_id": change_set.change_set_id,
                "change_set_path": str(
                    change_set.path
                    or Path(f"docs/changes/active/{change_set.change_set_id}.md")
                ),
                "active_work_item_id": scope.display_id,
                "active_work_item_type": scope.work_item_type.value,
                "active_plan_path": str(
                    scope.plan_path
                    or Path(f"docs/plans/active/{scope.display_id}/plan.md")
                ),
                "verification_goal_path": (
                    str(scope.verification_goal_path)
                    if scope.verification_goal_path
                    else None
                ),
                "affected_work_items": [
                    {
                        "id": item.display_id,
                        "type": item.work_item_type.value,
                        "plan_path": str(
                            item.plan_path
                            or Path(f"docs/plans/active/{item.display_id}/plan.md")
                        ),
                        "planner_inputs": [str(path) for path in item.planner_inputs],
                        "executor_inputs": [str(path) for path in item.executor_inputs],
                        "verification_goal_path": (
                            str(item.verification_goal_path)
                            if item.verification_goal_path
                            else None
                        ),
                    }
                    for item in scopes
                ],
            },
        )
        scope_result = RunnerEngine(BasicStepRunner()).run(materialized_workflow, context)
        result_by_work_item[scope.display_id] = scope_result
        final_result = scope_result
        if scope_result.status != RunStatus.SUCCEEDED:
            break

    if final_result is None:
        raise RuntimeError("workflow execution requires at least one ChangeSet work item")

    state = RunState(
        run_id=run_id,
        change_set_id=change_set.change_set_id,
        workflow_name=workflow.name,
        mode=RunMode.APPLY,
        affected_use_cases=affected_use_cases,
        affected_work_items=affected_work_items,
        current_use_case_id=affected_use_cases[0] if affected_use_cases else None,
        current_work_item_id=affected_work_items[0] if affected_work_items else None,
        status=final_result.status,
        work_item_states=tuple(
            WorkItemLoopState(
                work_item_id=scope.display_id,
                work_item_type=scope.work_item_type,
                active_plan_path=scope.plan_path
                or Path(f"docs/plans/active/{scope.display_id}/plan.md"),
                status=result_by_work_item.get(scope.display_id, final_result).status,
                current_step_id=scope.current_stage,
                verification_status=result_by_work_item.get(scope.display_id, final_result).status.value,
                blocker=result_by_work_item.get(scope.display_id, final_result).blocker,
            )
            for scope in scopes
        ),
        use_case_states=tuple(
            UseCaseLoopState(
                uc_id=scope.use_case.uc_id,
                active_plan_path=scope.plan_path
                or Path(f"docs/plans/active/{scope.use_case.uc_id}/plan.md"),
                status=result_by_work_item.get(scope.display_id, final_result).status,
                blocker=result_by_work_item.get(scope.display_id, final_result).blocker,
            )
            for scope in scopes
            if scope.use_case is not None
        ),
        failed_step_id=final_result.failed_step_id,
    )
    RunStateStore(repo_root).save(state)
    ReportWriter(repo_root).write(
        RunReport(
            run_id=run_id,
            change_set_id=change_set.change_set_id,
            workflow_name=workflow.name,
            mode=RunMode.APPLY,
            status=final_result.status,
            affected_use_cases=affected_use_cases,
            current_use_case_id=affected_use_cases[0] if affected_use_cases else None,
            work_item_reports=tuple(
                WorkItemReport(
                    work_item_id=scope.display_id,
                    work_item_type=scope.work_item_type,
                    active_plan_path=scope.plan_path
                    or Path(f"docs/plans/active/{scope.display_id}/plan.md"),
                    status=result_by_work_item.get(scope.display_id, final_result).status,
                    current_stage=scope.current_stage,
                    verification_goal_path=scope.verification_goal_path,
                    blocker=result_by_work_item.get(scope.display_id, final_result).blocker,
                    verification_result=result_by_work_item.get(scope.display_id, final_result).status.value,
                )
                for scope in scopes
            ),
        )
    )
    return state, final_result


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
