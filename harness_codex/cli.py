"""CLI entrypoint for ChangeSet and use-case workflow commands."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import replace as dataclass_replace
from datetime import datetime
from pathlib import Path
from typing import Mapping
from uuid import uuid4

from harness_codex.runtime import (
    AgentContextBootstrapResult,
    BasicStepRunner,
    ChangeSetCompletionBlocked,
    FailureKind,
    ReportWriter,
    ResumeDisposition,
    RunnerEngine,
    RunContext,
    RunMode,
    RunFailureKind,
    RunReport,
    RunResult,
    RunState,
    RunStateStore,
    RunStatus,
    Step,
    StepKind,
    UseCaseLoopState,
    WorkItemLoopState,
    WorkItemReport,
    bootstrap_agent_context,
    complete_change_set_if_ready,
    decide_resume_target,
    reconcile_procedure_stage_rows,
    runtime_stage_projection,
)
from harness_codex.runtime.changes import (
    ChangeSet,
    ChangeSetResolver,
    DesignBridgeError,
    NoActiveChangeSetsError,
    PlanningBlocked,
    create_changeset_from_design,
)
from harness_codex.runtime.contracts import contract_dashboard_projection_json
from harness_codex.runtime.contract_validators import (
    contract_results_to_json,
    format_contract_results,
    validate_contracts,
)
from harness_codex.runtime.dashboard import dashboard_state_json
from harness_codex.runtime.evolution import (
    EvolutionError,
    accept_evolution,
    propose_evolution,
    reject_evolution,
)
from harness_codex.runtime.procedure_stages import (
    PROCEDURE_STAGES,
    ProcedureStage,
    parse_procedure_stage_rows,
    procedure_stage,
    render_initial_changeset,
    replace_stage_placeholders,
    update_changeset_stage_status,
    verify_procedure_stage,
)
from harness_codex.runtime.reset import format_result as format_reset_result
from harness_codex.runtime.reset import run_reset
from harness_codex.runtime.self_update import DEFAULT_REF, DEFAULT_REPO, run_self_update
from harness_codex.runtime.shell_completion import install_completion as install_shell_completion
from harness_codex.runtime.ui_server import run_ui_server
from harness_codex.runtime.workflows import (
    WorkflowMaterializationError,
    load_named_workflow,
    materialize_workflow_for_scope,
    write_materialized_workflow_manifest,
)


INTERACTIVE_GRILL_ME_STAGE_IDS = frozenset(
    {
        "requirements-definition",
        "ubiquitous-language-definition",
        "use-case-definition",
        "event-storming",
    }
)


COMMAND_HELP: tuple[tuple[str, str], ...] = (
    ("help", "Show runtime help."),
    ("init", "Initialize repo-local agent context files."),
    ("agent-context", "Initialize repo-local agent context files."),
    ("changes", "List, inspect, create, or delete ChangeSets."),
    ("contracts", "Validate document handoff contracts."),
    ("completion", "Install shell completion."),
    ("requirements-definition", "Define requirements and create temp ChangeSet when needed."),
    ("ubiquitous-language-definition", "Define project ubiquitous language."),
    ("use-case-definition", "Define use cases and finalize temp ChangeSet."),
    ("event-storming", "Create event storming for one use case."),
    ("ddd-architecture-definition", "Create DDD architecture for one use case."),
    ("technical-decisions", "Record technical decisions for one use case."),
    ("plan-writing", "Write implementation plan for one use case."),
    ("implementation", "Run implementation for one use case."),
    ("ultrawork", "Create a ChangeSet and run affected workflows."),
    ("evolution", "Manage evolution proposals."),
    ("stages", "Inspect runtime procedure stage artifacts."),
    ("artifacts", "Show or accept generated stage artifacts."),
    ("resume", "Inspect next resume target for one run."),
    ("report", "Print one run report."),
    ("dashboard", "Print dashboard state JSON."),
    ("ui-server", "Run local dashboard server."),
    ("update", "Update installed harness-codex runtime files."),
    ("reset", "Reset local harness runtime artifacts."),
)


TOPIC_HELP: Mapping[str, str] = {
    "help": "Usage: harness help [command]\n\nShow runtime help. Without command, prints command overview.",
    "init": "Usage: harness init [--description TEXT] [--force] [--no-llm]",
    "agent-context": "Usage: harness agent-context init [--description TEXT] [--force] [--llm|--no-llm]",
    "changes": (
        "Usage: harness changes list|active\n"
        "       harness changes show|delete|contents <CHG-ID>\n"
        "       harness changes document-delta <CHG-ID> --uc UC-ID --summary TEXT --plan|--preview|--apply"
    ),
    "contracts": "Usage: harness contracts validate <CHG-ID> [--work-item ID] [--json]",
    "completion": "Usage: harness completion install [--shell auto|zsh|bash|all]",
    "requirements-definition": "Usage: harness requirements-definition [CHG-ID] --plan|--preview|--apply",
    "ubiquitous-language-definition": "Usage: harness ubiquitous-language-definition <CHG-ID> --plan|--preview|--apply",
    "use-case-definition": "Usage: harness use-case-definition <CHG-ID> --plan|--preview|--apply",
    "event-storming": "Usage: harness event-storming <CHG-ID> --uc UC-ID --plan|--preview|--apply",
    "ddd-architecture-definition": "Usage: harness ddd-architecture-definition <CHG-ID> --uc UC-ID --plan|--preview|--apply",
    "technical-decisions": "Usage: harness technical-decisions <CHG-ID> --uc UC-ID --plan|--preview|--apply",
    "plan-writing": "Usage: harness plan-writing <CHG-ID> --uc UC-ID --plan|--preview|--apply",
    "implementation": "Usage: harness implementation <CHG-ID> --uc UC-ID --plan|--preview|--apply",
    "ultrawork": (
        "Usage: harness ultrawork [--title TEXT] [--change-set-id ID] "
        "[--uc UC-ID] [--force] [--plan|--preview|--apply]"
    ),
    "evolution": "Usage: harness evolution propose|accept|reject ...",
    "stages": "Usage: harness stages list <CHG-ID>",
    "artifacts": "Usage: harness artifacts show|accept <CHG-ID> <stage>",
    "resume": "Usage: harness resume <RUN-ID>",
    "report": "Usage: harness report <RUN-ID>",
    "dashboard": "Usage: harness dashboard [contracts --change-set CHG-ID --format json]",
    "ui-server": "Usage: harness ui-server [--host HOST] [--port PORT]",
    "update": "Usage: harness update [--repo URL] [--ref REF] [--skip-venv] [--dry-run]",
    "reset": "Usage: harness reset (--runs|--workflow-artifacts|--all) [--apply]",
}


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
    parser = argparse.ArgumentParser(
        prog="harness",
        description="Harness runtime for ChangeSet and use-case workflows.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=_format_command_list(),
    )
    parser.add_argument("--repo-root", default=".")
    subparsers = parser.add_subparsers(required=True, metavar="command")

    help_parser = subparsers.add_parser(
        "help",
        description="Show runtime command help.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    help_parser.add_argument("topic", nargs="?", choices=tuple(TOPIC_HELP))
    help_parser.set_defaults(func=help_command)

    init = subparsers.add_parser("init")
    init.add_argument("--description", default="")
    init.add_argument("--force", action="store_true")
    init.add_argument("--no-llm", action="store_true")
    init.set_defaults(func=init_command)

    update = subparsers.add_parser(
        "update",
        description="Update the installed harness-codex runtime in this project.",
    )
    update.add_argument(
        "--repo",
        default=DEFAULT_REPO,
        help=f"harness-codex repository URL. Default: {DEFAULT_REPO}",
    )
    update.add_argument(
        "--ref",
        default=DEFAULT_REF,
        help="branch, tag, or commit to install. Defaults to origin/main.",
    )
    update.add_argument(
        "--skip-venv",
        action="store_true",
        help="Skip venv creation and dependency installation.",
    )
    update.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the installer command without running it.",
    )
    update.set_defaults(func=update_command)

    agent_context = subparsers.add_parser("agent-context")
    agent_context_subparsers = agent_context.add_subparsers(required=True)
    agent_context_init = agent_context_subparsers.add_parser("init")
    agent_context_init.add_argument("--description", default="")
    agent_context_init.add_argument("--force", action="store_true")
    agent_context_init.add_argument("--llm", action="store_true")
    agent_context_init.add_argument("--no-llm", action="store_true")
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
    changes_delete = changes_subparsers.add_parser("delete")
    changes_delete.add_argument("change_set_id")
    changes_delete.set_defaults(func=changes_delete_command)
    changes_contents = changes_subparsers.add_parser("contents")
    changes_contents.add_argument("change_set_id")
    changes_contents.add_argument(
        "--raw",
        action="store_true",
        help="Print the raw ChangeSet markdown file instead of the structured summary.",
    )
    changes_contents.set_defaults(func=changes_contents_command)
    changes_document_delta = changes_subparsers.add_parser("document-delta")
    changes_document_delta.add_argument("change_set_id")
    changes_document_delta.add_argument("--uc", required=True)
    changes_document_delta.add_argument(
        "--target",
        choices=("technical-decisions",),
        default="technical-decisions",
    )
    changes_document_delta.add_argument("--summary", required=True)
    changes_document_delta.add_argument("--plan-note", default="")
    _add_mode_options(changes_document_delta)
    changes_document_delta.set_defaults(func=changes_document_delta_command)

    contracts = subparsers.add_parser("contracts")
    contracts_subparsers = contracts.add_subparsers(required=True)
    contracts_validate = contracts_subparsers.add_parser("validate")
    contracts_validate.add_argument("change_set_id")
    contracts_validate.add_argument("--work-item", default="")
    contracts_validate.add_argument("--json", action="store_true")
    contracts_validate.set_defaults(func=contracts_validate_command)

    completion = subparsers.add_parser("completion")
    completion_subparsers = completion.add_subparsers(required=True)
    completion_install = completion_subparsers.add_parser("install")
    completion_install.add_argument("--shell", choices=("auto", "zsh", "bash", "all"), default="auto")
    completion_install.set_defaults(func=completion_install_command)

    for stage in PROCEDURE_STAGES:
        _add_procedure_stage_parser(subparsers, stage)

    ultrawork = subparsers.add_parser(
        "ultrawork",
        description=(
            "Create a ChangeSet from canonical design documents and immediately "
            "run every affected workflow."
        ),
    )
    ultrawork.add_argument("--title", default="")
    ultrawork.add_argument("--change-set-id")
    ultrawork.add_argument("--related-issue", default="")
    ultrawork.add_argument(
        "--uc",
        action="append",
        default=[],
        help="Limit generated slices to one canonical use case. May be passed more than once.",
    )
    ultrawork.add_argument("--force", action="store_true")
    _add_optional_mode_options(ultrawork)
    ultrawork.set_defaults(func=ultrawork_command)

    evolution = subparsers.add_parser("evolution")
    evolution_subparsers = evolution.add_subparsers(required=True)
    evolution_propose = evolution_subparsers.add_parser("propose")
    evolution_propose.add_argument("--change-set", required=True)
    evolution_propose.add_argument("--work-item", required=True)
    evolution_propose.add_argument("--run-id", required=True)
    evolution_propose.set_defaults(func=evolution_propose_command)
    evolution_accept = evolution_subparsers.add_parser("accept")
    evolution_accept.add_argument("proposal_id")
    evolution_accept.set_defaults(func=evolution_accept_command)
    evolution_reject = evolution_subparsers.add_parser("reject")
    evolution_reject.add_argument("proposal_id")
    evolution_reject.set_defaults(func=evolution_reject_command)

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

    resume = subparsers.add_parser("resume")
    resume.add_argument("run_id")
    resume.set_defaults(func=resume_command)

    report = subparsers.add_parser("report")
    report.add_argument("run_id")
    report.set_defaults(func=report_command)

    dashboard = subparsers.add_parser("dashboard")
    dashboard_subparsers = dashboard.add_subparsers(dest="dashboard_subcommand")
    dashboard_contracts = dashboard_subparsers.add_parser("contracts")
    dashboard_contracts.add_argument("--change-set", default="")
    dashboard_contracts.add_argument("--format", choices=("json",), default="json")
    dashboard_contracts.set_defaults(func=dashboard_contracts_command)
    dashboard.set_defaults(func=dashboard_command)

    ui_server = subparsers.add_parser("ui-server")
    ui_server.add_argument("--host", default="127.0.0.1")
    ui_server.add_argument("--port", type=int, default=8765)
    ui_server.set_defaults(func=ui_server_command)

    reset = subparsers.add_parser(
        "reset",
        description="Reset local harness runtime artifacts explicitly.",
    )
    reset_scope = reset.add_mutually_exclusive_group(required=True)
    reset_scope.add_argument("--runs", action="store_true")
    reset_scope.add_argument("--workflow-artifacts", action="store_true")
    reset_scope.add_argument("--all", action="store_true")
    reset.add_argument("--apply", action="store_true")
    reset.set_defaults(func=reset_command)

    return parser


def _format_command_list() -> str:
    width = max(len(command) for command, _ in COMMAND_HELP)
    lines = ["Commands:"]
    lines.extend(f"  {command.ljust(width)}  {summary}" for command, summary in COMMAND_HELP)
    lines.append("")
    lines.append("Use `harness help <command>` for command usage.")
    return "\n".join(lines)


def _add_procedure_stage_parser(
    subparsers: argparse._SubParsersAction,
    stage: ProcedureStage,
) -> None:
    command = subparsers.add_parser(stage.stage_id)
    if stage.stage_id == "requirements-definition":
        command.add_argument("change_set_id", nargs="?")
    else:
        command.add_argument("change_set_id")
    command.add_argument("--uc", default="")
    command.add_argument("--title", default="")
    command.add_argument("--idea", default="")
    _add_mode_options(command)
    command.set_defaults(func=procedure_stage_command, procedure_stage_id=stage.stage_id)


def update_command(args: argparse.Namespace, repo_root: Path) -> str:
    return run_self_update(repo_root, args)


def reset_command(args: argparse.Namespace, repo_root: Path) -> str:
    return format_reset_result(run_reset(repo_root, args))


def completion_install_command(args: argparse.Namespace, repo_root: Path) -> str:
    results = install_shell_completion(repo_root, shell=args.shell)
    lines = ["Installed harness shell completion:"]
    for result in results:
        lines.append(f"- {result.shell}: {result.source} -> {result.target}")
        lines.append(f"  {result.note}")
    return "\n".join(lines)


def help_command(args: argparse.Namespace, repo_root: Path) -> str:
    if not args.topic:
        return "\n".join(
            [
                "Harness runtime commands",
                "",
                _format_command_list(),
            ]
        )
    return TOPIC_HELP[args.topic]


def init_command(args: argparse.Namespace, repo_root: Path) -> str:
    result = bootstrap_agent_context(
        repo_root,
        _repo_description(args.description),
        force=args.force,
        use_llm=not args.no_llm,
    )
    return _format_agent_context_result(result)


def agent_context_init_command(args: argparse.Namespace, repo_root: Path) -> str:
    result = bootstrap_agent_context(
        repo_root,
        _repo_description(args.description),
        force=args.force,
        use_llm=bool(args.llm and not args.no_llm),
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


def changes_delete_command(args: argparse.Namespace, repo_root: Path) -> str:
    path = Path("docs/changes/active") / f"{args.change_set_id}.md"
    absolute_path = repo_root / path
    if not absolute_path.exists():
        raise ValueError(f"Active ChangeSet file not found: {path}")

    absolute_path.unlink()
    return f"DELETED: {path}"


def changes_contents_command(args: argparse.Namespace, repo_root: Path) -> str:
    change_set = _load_change_set(repo_root, args.change_set_id)
    if args.raw:
        path = _change_set_file_path(change_set)
        absolute_path = repo_root / path
        if not absolute_path.exists():
            raise ValueError(f"ChangeSet file not found: {path}")
        return absolute_path.read_text(encoding="utf-8").strip()
    return _format_change_set_contents(change_set)


def changes_document_delta_command(args: argparse.Namespace, repo_root: Path) -> str:
    mode = _selected_mode(args)
    change_set = _load_change_set(repo_root, args.change_set_id)
    use_case = next((uc for uc in change_set.affected_use_cases if uc.uc_id == args.uc), None)
    if use_case is None:
        return f"BLOCKED: {args.uc} is not affected by {change_set.change_set_id}"

    target_path = use_case.slice_path / "technical-decisions.md"
    active_plan_path = Path("docs/plans/active") / args.uc / "plan.md"
    plan_note = args.plan_note or args.summary
    delta_block = _document_delta_block(
        change_set_id=change_set.change_set_id,
        uc_id=args.uc,
        summary=args.summary,
        plan_note=plan_note,
    )
    plan_block = _plan_delta_block(
        target_path=target_path,
        summary=args.summary,
        plan_note=plan_note,
    )

    if mode in (RunMode.PLAN, RunMode.PREVIEW):
        return "\n".join(
            [
                f"Mode: {mode.value}",
                f"ChangeSet: {change_set.change_set_id}",
                f"UC: {args.uc}",
                f"Target: {target_path}",
                f"Plan patch: {active_plan_path if (repo_root / active_plan_path).exists() else '-'}",
                "Side effects: false",
            ]
        )

    target_absolute = repo_root / target_path
    if not target_absolute.exists():
        return f"BLOCKED: target document not found: {target_path}"
    _append_once(target_absolute, delta_block)

    plan_patched = False
    plan_absolute = repo_root / active_plan_path
    if plan_absolute.exists():
        _append_once(plan_absolute, plan_block)
        plan_patched = True

    return "\n".join(
        [
            f"APPLIED document delta: {change_set.change_set_id}",
            f"Target: {target_path}",
            f"Plan patched: {active_plan_path if plan_patched else '-'}",
        ]
    )


def _document_delta_block(
    *,
    change_set_id: str,
    uc_id: str,
    summary: str,
    plan_note: str,
) -> str:
    return "\n".join(
        [
            "## Runtime Document Delta",
            "",
            f"- ChangeSet: `{change_set_id}`",
            f"- UC: `{uc_id}`",
            f"- Summary: {summary}",
            f"- Plan impact: {plan_note}",
            "",
        ]
    )


def _plan_delta_block(*, target_path: Path, summary: str, plan_note: str) -> str:
    return "\n".join(
        [
            "## Document Delta Update",
            "",
            f"- Source: `{target_path}`",
            f"- Summary: {summary}",
            f"- Plan note: {plan_note}",
            "",
        ]
    )


def _append_once(path: Path, block: str) -> None:
    original = path.read_text(encoding="utf-8")
    if block.strip() in original:
        return
    separator = "\n\n" if original.strip() else ""
    path.write_text(original.rstrip() + separator + block, encoding="utf-8")


def contracts_validate_command(args: argparse.Namespace, repo_root: Path) -> str:
    results = validate_contracts(
        repo_root,
        change_set_id=args.change_set_id,
        work_item_id=args.work_item.strip() or None,
    )
    if args.json:
        return contract_results_to_json(results).strip()
    return format_contract_results(results)


def _format_change_set_contents(change_set: ChangeSet) -> str:
    lines = [
        f"ChangeSet contents: {change_set.change_set_id}",
        f"Path: {_change_set_file_path(change_set)}",
        f"Title: {change_set.title or '-'}",
        f"Status: {change_set.status or '-'}",
        f"Related issue: {change_set.related_issue or '-'}",
        f"Intent: {change_set.intent_summary or '-'}",
        "Before / After:",
        f"- Before: {change_set.before_summary or '-'}",
        f"- After: {change_set.after_summary or '-'}",
    ]

    _extend_lines(
        lines,
        "Changed documents:",
        (
            f"- {item.path} [{item.change_type or '-'}] status={item.status or '-'} reason={item.reason or '-'}"
            for item in change_set.changed_documents
        ),
    )
    _extend_lines(
        lines,
        "Work items:",
        (
            "\n".join(
                [
                    f"- {item.work_item_id} ({item.work_item_type.value})",
                    f"  name: {item.name or '-'}",
                    f"  impact: {item.impact_type or '-'}",
                    f"  slice: {item.slice_path}",
                    f"  status: {item.status or '-'}",
                ]
            )
            for item in change_set.ordered_work_items()
        ),
    )
    _extend_lines(lines, "Planner inputs:", (f"- {path}" for path in change_set.planner_inputs))
    _extend_lines(lines, "Included scope:", (f"- {item}" for item in change_set.included_scope))
    _extend_lines(lines, "Excluded scope:", (f"- {item}" for item in change_set.excluded_scope))
    _extend_lines(lines, "Forbidden changes:", (f"- {item}" for item in change_set.forbidden_changes))
    return "\n".join(lines)


def _extend_lines(lines: list[str], heading: str, items: object) -> None:
    materialized = list(items)
    lines.append(heading)
    lines.extend(materialized or ["- none"])


def _change_set_file_path(change_set: ChangeSet) -> Path:
    return change_set.path or Path("docs/changes/active") / f"{change_set.change_set_id}.md"


def ultrawork_command(args: argparse.Namespace, repo_root: Path) -> str:
    result, agent_context = _create_changeset_from_design(repo_root, args)
    mode = _selected_mode(args)
    prep_outputs = _run_post_changeset_prep_workflows(
        repo_root,
        result.change_set_id,
        tuple(use_case.uc_id for use_case in result.use_cases),
        args,
    )
    blocked_prep = any(not _procedure_stage_output_allows_next(output) for output in prep_outputs)
    run_args = argparse.Namespace(
        change_set_id=result.change_set_id,
        plan=mode == RunMode.PLAN,
        preview=mode == RunMode.PREVIEW,
        apply=mode == RunMode.APPLY,
    )
    run_output = (
        "SKIPPED: post-ChangeSet prep workflow blocked"
        if blocked_prep
        else run_change_command(run_args, repo_root)
    )
    return "\n".join(
        [
            f"CREATED: {result.change_set_id}",
            f"ChangeSet: {result.change_set_path}",
            "Affected use cases:",
            *[f"- {use_case.uc_id}: {use_case.name}" for use_case in result.use_cases],
            _format_agent_context_result(agent_context),
            "Post-ChangeSet prep workflows:",
            *prep_outputs,
            "Workflow run:",
            run_output,
        ]
    )


def _create_changeset_from_design(
    repo_root: Path,
    args: argparse.Namespace,
):
    title, change_set_id = _resolve_changes_create_from_design_inputs(repo_root, args)
    result = create_changeset_from_design(
        repo_root,
        title=title,
        change_set_id=change_set_id,
        related_issue=args.related_issue,
        selected_use_cases=tuple(args.uc),
        force=args.force,
    )
    agent_context = bootstrap_agent_context(repo_root, _repo_description(title))
    return result, agent_context


def _run_post_changeset_prep_workflows(
    repo_root: Path,
    change_set_id: str,
    use_case_ids: tuple[str, ...],
    args: argparse.Namespace,
) -> list[str]:
    outputs: list[str] = []
    for uc_id in use_case_ids:
        for stage_id in (
            "event-storming",
            "ddd-architecture-definition",
            "technical-decisions",
        ):
            stage_args = argparse.Namespace(
                procedure_stage_id=stage_id,
                change_set_id=change_set_id,
                uc=uc_id,
                title=args.title,
                idea=args.title,
                plan=args.plan,
                preview=args.preview,
                apply=not args.plan and not args.preview,
            )
            output = procedure_stage_command(stage_args, repo_root)
            outputs.append(output)
            if not _procedure_stage_output_allows_next(output):
                return outputs
    return outputs


def _procedure_stage_output_allows_next(output: str) -> bool:
    return (
        "ChangeSet status: blocked" not in output
        and "Verification: failed" not in output
        and not output.startswith("BLOCKED:")
    )


def _resolve_changes_create_from_design_inputs(
    repo_root: Path,
    args: argparse.Namespace,
) -> tuple[str, str | None]:
    title = args.title.strip()
    change_set_id = (args.change_set_id or "").strip() or None

    if not title:
        title = input("Change title: ").strip()
        if not title:
            raise ValueError("change title is required")

    if not _design_docs_exist(repo_root):
        return title, change_set_id

    if change_set_id is None:
        suggested = _suggest_next_change_set_id(repo_root)
        entered = input(
            f"ChangeSet ID [{suggested}] (press Enter to accept): "
        ).strip()
        change_set_id = entered or suggested

    return title, change_set_id


def procedure_stage_command(args: argparse.Namespace, repo_root: Path) -> str:
    stage = procedure_stage(args.procedure_stage_id)
    mode = _selected_mode(args)
    uc_id = args.uc.strip() or None
    if stage.requires_uc and not uc_id:
        raise ValueError(f"{stage.stage_id} requires --uc")

    args.change_set_id = _resolve_procedure_change_set_id(repo_root, args, mode)
    change_set_path = Path("docs/changes/active") / f"{args.change_set_id}.md"
    if mode == RunMode.PLAN:
        return _format_procedure_stage_plan(stage, args.change_set_id, uc_id)

    if stage.stage_id == "requirements-definition" and not (repo_root / change_set_path).exists():
        if mode == RunMode.PREVIEW:
            return f"BLOCKED: ChangeSet does not exist yet: {change_set_path}"
        _create_initial_procedure_changeset(
            repo_root,
            change_set_path,
            change_set_id=args.change_set_id,
            title=args.title or args.idea or args.change_set_id,
            idea=args.idea,
        )
    elif not (repo_root / change_set_path).exists():
        return f"BLOCKED: ChangeSet does not exist: {change_set_path}"

    if mode == RunMode.PREVIEW:
        passed, problems = verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=args.change_set_id,
            uc_id=uc_id,
        )
        return _format_procedure_stage_verification(stage, passed, problems)

    if stage.stage_id in INTERACTIVE_GRILL_ME_STAGE_IDS:
        return _run_interactive_procedure_stage(
            args,
            repo_root,
            stage,
            uc_id,
            change_set_path,
        )

    run_id = f"run-{uuid4().hex[:12]}"
    context = RunContext(
        run_id=run_id,
        workflow_name=f"procedure-{stage.stage_id}",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs" / run_id,
        metadata={
            "change_set_id": args.change_set_id,
            "procedure_stage": stage.stage_id,
            "uc_id": uc_id,
            "idea": args.idea,
        },
    )
    step = Step(
        id=stage.stage_id,
        kind=StepKind.AGENT,
        name=stage.display_name,
        agent_id=stage.agent_id,
        skill_id=stage.skill_id,
        inputs=replace_stage_placeholders(
            stage.inputs,
            change_set_id=args.change_set_id,
            uc_id=uc_id,
        ),
        outputs=replace_stage_placeholders(
            stage.outputs,
            change_set_id=args.change_set_id,
            uc_id=uc_id,
        ),
        timeout_sec=3600,
        metadata={"procedure_stage": stage.stage_id},
    )
    result = BasicStepRunner().run(step, context)
    passed, problems = verify_procedure_stage(
        repo_root,
        stage,
        change_set_id=args.change_set_id,
        uc_id=uc_id,
    )
    status = "verified" if result.successful and passed else "blocked"
    notes = "; ".join(problems) or result.error or "-"
    _record_procedure_stage_status(repo_root, change_set_path, stage, status, notes)
    lines = [
        f"Stage: {stage.stage_id}",
        f"Run: {run_id}",
        f"Agent status: {result.status.value}",
        f"Verification: {'passed' if passed else 'failed'}",
        f"ChangeSet status: {status}",
        f"Notes: {notes}",
    ]
    if stage.stage_id == "use-case-definition" and status == "verified":
        finalized = _finalize_temporary_changeset(
            repo_root,
            change_set_id=args.change_set_id,
            run_id=run_id,
        )
        if finalized:
            final_id, final_path = finalized
            lines.append(f"Finalized ChangeSet: {args.change_set_id} -> {final_id}")
            lines.append(f"Finalized path: {final_path}")
    return "\n".join(lines)


def _resolve_procedure_change_set_id(
    repo_root: Path,
    args: argparse.Namespace,
    mode: RunMode,
) -> str:
    provided = (args.change_set_id or "").strip()
    if provided:
        return provided
    if args.procedure_stage_id != "requirements-definition":
        raise ValueError(f"{args.procedure_stage_id} requires change_set_id")
    if mode == RunMode.PLAN:
        return "CHG-TEMP-<auto>"
    return _suggest_temporary_change_set_id(repo_root)


def _suggest_temporary_change_set_id(repo_root: Path) -> str:
    repo = Path(repo_root)
    date = datetime.now().strftime("%Y%m%d")
    directories = (
        repo / "docs/changes/active",
        repo / "docs/changes/completed",
    )
    sequence = 1
    for directory in directories:
        if not directory.exists():
            continue
        for path in directory.glob(f"CHG-TEMP-{date}-*.md"):
            try:
                sequence = max(sequence, int(path.stem.rsplit("-", maxsplit=1)[1]) + 1)
            except (IndexError, ValueError):
                continue
    return f"CHG-TEMP-{date}-{sequence:03d}"


def _design_docs_exist(repo_root: Path) -> bool:
    repo = Path(repo_root)
    return all(
        (repo / relative_path).exists()
        for relative_path in (
            Path("docs/design/요구사항.md"),
            Path("docs/design/유스케이스.md"),
        )
    )


def _suggest_next_change_set_id(repo_root: Path) -> str:
    repo = Path(repo_root)
    date = datetime.now().strftime("%Y%m%d")
    directories = (
        repo / "docs/changes/active",
        repo / "docs/changes/completed",
    )
    sequence = 1
    for directory in directories:
        if not directory.exists():
            continue
        for path in directory.glob(f"CHG-{date}-*.md"):
            try:
                sequence = max(sequence, int(path.stem.rsplit("-", maxsplit=1)[1]) + 1)
            except (IndexError, ValueError):
                continue
    return f"CHG-{date}-{sequence:03d}"


def _finalize_temporary_changeset(
    repo_root: Path,
    *,
    change_set_id: str,
    run_id: str,
) -> tuple[str, Path] | None:
    if not change_set_id.startswith("CHG-TEMP-"):
        return None

    old_path = Path("docs/changes/active") / f"{change_set_id}.md"
    old_absolute = repo_root / old_path
    if not old_absolute.exists() or not _design_docs_exist(repo_root):
        return None

    old_text = old_absolute.read_text(encoding="utf-8")
    final_title = _title_from_design(repo_root) or change_set_id
    final_id = _suggest_next_change_set_id(repo_root)
    result = create_changeset_from_design(
        repo_root,
        title=final_title,
        change_set_id=final_id,
        force=False,
    )
    final_absolute = repo_root / result.change_set_path
    final_text = final_absolute.read_text(encoding="utf-8")
    final_absolute.write_text(
        _append_runtime_procedure_state(final_text, old_text),
        encoding="utf-8",
    )
    old_absolute.unlink()
    _retarget_run_state(repo_root, run_id=run_id, change_set_id=final_id)
    return final_id, result.change_set_path


def _title_from_design(repo_root: Path) -> str:
    for relative_path in (Path("docs/design/요구사항.md"), Path("docs/design/유스케이스.md")):
        path = repo_root / relative_path
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if stripped.startswith(("-", "*")):
                stripped = stripped.lstrip("-* ").strip()
            if ":" in stripped:
                stripped = stripped.split(":", maxsplit=1)[1].strip()
            return stripped.rstrip(".")
    return ""


def _append_runtime_procedure_state(final_text: str, old_text: str) -> str:
    heading = "## 3. Runtime Procedure State"
    start = old_text.find(heading)
    if start < 0:
        return final_text
    end = old_text.find("\n## ", start + len(heading))
    procedure_section = old_text[start : end if end >= 0 else len(old_text)].strip()
    if not procedure_section:
        return final_text
    if heading in final_text:
        return final_text
    return final_text.rstrip() + "\n\n" + procedure_section + "\n"


def _retarget_run_state(repo_root: Path, *, run_id: str, change_set_id: str) -> None:
    store = RunStateStore(repo_root)
    try:
        state = store.load(run_id)
    except (FileNotFoundError, KeyError, ValueError):
        return
    store.save(dataclass_replace(state, change_set_id=change_set_id))


def _run_interactive_procedure_stage(
    args: argparse.Namespace,
    repo_root: Path,
    stage: ProcedureStage,
    uc_id: str | None,
    change_set_path: Path,
) -> str:
    run_id = f"run-{uuid4().hex[:12]}"
    run_dir = repo_root / ".harness/runs" / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    session = {
        "run_id": run_id,
        "change_set_id": args.change_set_id,
        "stage": stage.stage_id,
        "uc_id": uc_id,
        "idea": args.idea,
        "answers": [],
        "reviews": [],
        "review_feedback": [],
        "turns": [],
        "status": "running",
    }
    _save_interactive_stage_session(run_dir, session)

    final_result: dict | None = None
    for turn in range(1, 13):
        prompt = _interactive_stage_prompt(args, stage, uc_id, session)
        raw_result = _exec_stage_grill_me_prompt(
            repo_root,
            run_dir / f"turn-{turn:02d}",
            prompt,
            f"{stage.stage_id} Grill-Me turn",
        )
        result = _parse_interactive_stage_json(raw_result)
        session["turns"].append(
            {
                "turn": turn,
                "status": result["status"],
                "questions": result["questions"],
                "changed_files": result["changed_files"],
                "blocker": result["blocker"],
            }
        )
        final_result = result

        if result["status"] == "needs_input":
            answers = _read_interactive_stage_answers(stage, result["questions"])
            session["answers"].extend(answers)
            _save_interactive_stage_session(run_dir, session)
            continue

        if result["status"] == "complete":
            review_prompt = _interactive_stage_review_prompt(
                args,
                stage,
                uc_id,
                session,
                result,
                run_dir,
            )
            raw_review = _exec_stage_review_prompt(
                repo_root,
                run_dir / f"turn-{turn:02d}-review",
                review_prompt,
                f"{stage.stage_id} content review",
            )
            review = _parse_interactive_review_json(raw_review)
            session["reviews"].append(
                {
                    "turn": turn,
                    "status": review["status"],
                    "questions": review["questions"],
                    "review_file": review["review_file"],
                    "findings": review["findings"],
                    "blocker": review["blocker"],
                }
            )
            _save_interactive_stage_session(run_dir, session)

            if review["status"] == "needs_input":
                session["review_feedback"].append(
                    {
                        "turn": turn,
                        "status": review["status"],
                        "review_file": review["review_file"],
                        "findings": review["findings"],
                        "blocker": review["blocker"],
                    }
                )
                answers = _read_interactive_stage_answers(stage, review["questions"])
                session["answers"].extend(
                    {
                        **answer,
                        "source": "content_review",
                        "review_file": review["review_file"],
                    }
                    for answer in answers
                )
                _save_interactive_stage_session(run_dir, session)
                continue

            if review["status"] == "blocked":
                session["review_feedback"].append(
                    {
                        "turn": turn,
                        "status": review["status"],
                        "review_file": review["review_file"],
                        "findings": review["findings"],
                        "blocker": review["blocker"]
                        or "content review rejected stage artifacts",
                    }
                )
                _save_interactive_stage_session(run_dir, session)
                continue

        session["status"] = result["status"]
        _save_interactive_stage_session(run_dir, session)
        break
    else:
        session["status"] = "blocked"
        session["blocker"] = "interactive Grill-Me stage exceeded 12 turns"
        _save_interactive_stage_session(run_dir, session)
        raise ValueError("interactive Grill-Me stage exceeded 12 turns")

    if final_result is None:
        raise ValueError("interactive Grill-Me stage returned no result")

    if final_result["status"] == "blocked":
        status = "blocked"
        notes = final_result["blocker"] or "interactive Grill-Me stage blocked"
        verification = "skipped"
    else:
        passed, problems = verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=args.change_set_id,
            uc_id=uc_id,
        )
        status = "verified" if passed else "blocked"
        notes = "; ".join(problems) or "interactive Grill-Me stage complete"
        verification = "passed" if passed else "failed"

    _record_procedure_stage_status(repo_root, change_set_path, stage, status, notes)
    lines = [
        f"Stage: {stage.stage_id}",
        f"Run: {run_id}",
        f"Interactive status: {final_result['status']}",
        f"Verification: {verification}",
        f"ChangeSet status: {status}",
        f"Changed files: {', '.join(final_result['changed_files']) or '-'}",
        f"Session: {Path('.harness/runs') / run_id / 'grill-me-session.json'}",
        f"Notes: {notes}",
    ]
    if session.get("reviews"):
        latest_review = session["reviews"][-1]
        lines.append(f"Content review: {latest_review['status']}")
        lines.append(f"Review file: {latest_review['review_file'] or '-'}")
    if stage.stage_id == "use-case-definition" and status == "verified":
        finalized = _finalize_temporary_changeset(
            repo_root,
            change_set_id=args.change_set_id,
            run_id=run_id,
        )
        if finalized:
            final_id, final_path = finalized
            lines.append(f"Finalized ChangeSet: {args.change_set_id} -> {final_id}")
            lines.append(f"Finalized path: {final_path}")
    return "\n".join(lines)


def _utf8_safe_text(value: object) -> str:
    return str(value).encode("utf-8", errors="replace").decode("utf-8")


def _json_dumps_utf8_safe(value: object) -> str:
    return _utf8_safe_text(json.dumps(value, ensure_ascii=False, indent=2))


def _read_interactive_stage_answers(
    stage: ProcedureStage,
    questions: list[dict[str, str]],
) -> list[dict[str, str]]:
    answers: list[dict[str, str]] = []
    print(f"{stage.stage_id} Grill-Me questions:")
    for index, question in enumerate(questions, start=1):
        print(f"{index}. {question['question']}")
        if question["recommended"]:
            print(f"Recommended answer: {question['recommended']}")
        try:
            answer = input(f"Answer {index}: ").strip()
        except EOFError as exc:
            raise ValueError("answer is required for interactive Grill-Me question") from exc
        answer = _utf8_safe_text(answer)
        if not answer:
            raise ValueError("answer is required for interactive Grill-Me question")
        answers.append(
            {
                "question": _utf8_safe_text(question["question"]),
                "recommended": _utf8_safe_text(question["recommended"]),
                "answer": answer,
            }
        )
    return answers


def _interactive_stage_prompt(
    args: argparse.Namespace,
    stage: ProcedureStage,
    uc_id: str | None,
    session: dict,
) -> str:
    inputs = replace_stage_placeholders(
        stage.inputs,
        change_set_id=args.change_set_id,
        uc_id=uc_id,
    )
    outputs = replace_stage_placeholders(
        stage.outputs,
        change_set_id=args.change_set_id,
        uc_id=uc_id,
    )
    return f"""Use ${stage.skill_id} to run the `{stage.stage_id}` stage.

You are running inside the main harness workflow. Draft or update the stage artifacts first, then decide whether the draft has blocking ambiguity.
If content review feedback exists, revise the stage artifacts to address it before returning `complete`.

Return only JSON with keys: status, questions, changed_files, blocker.

Status rules:
- `needs_input`: draft artifacts were written or updated, but user answers are required before the stage can be correct.
- `complete`: required artifacts are written and no blocking ambiguity remains.
- `blocked`: upstream inputs are missing or contradictory and this stage cannot resolve the issue by asking the user.

Question rules:
- Ask at most 3 focused Grill-Me questions in `questions`.
- Every question must have `question` and `recommended`.
- Ask only questions inside this stage boundary.
- Do not ask any question already answered in answer history.

Stage boundary:
{_interactive_stage_boundary(stage.stage_id)}

ChangeSet: {args.change_set_id}
UC: {uc_id or "-"}
Idea: {_utf8_safe_text(args.idea or "-")}

Inputs:
{chr(10).join(f"- {path}" for path in inputs)}

Outputs:
{chr(10).join(f"- {path}" for path in outputs)}

Answer history:
{_json_dumps_utf8_safe(session.get("answers", []))}

Content review feedback:
{_json_dumps_utf8_safe(session.get("review_feedback", []))}

JSON examples:
{{"status":"needs_input","questions":[{{"question":"What decision is needed?","recommended":"Recommended answer."}}],"changed_files":["docs/design/요구사항.md"],"blocker":""}}
{{"status":"complete","questions":[],"changed_files":["docs/design/요구사항.md"],"blocker":""}}
{{"status":"blocked","questions":[],"changed_files":[],"blocker":"Concrete blocker."}}
"""


def _interactive_stage_review_prompt(
    args: argparse.Namespace,
    stage: ProcedureStage,
    uc_id: str | None,
    session: dict,
    stage_result: dict,
    run_dir: Path,
) -> str:
    inputs = replace_stage_placeholders(
        stage.inputs,
        change_set_id=args.change_set_id,
        uc_id=uc_id,
    )
    outputs = replace_stage_placeholders(
        stage.outputs,
        change_set_id=args.change_set_id,
        uc_id=uc_id,
    )
    review_file = run_dir / "reviews" / f"{stage.stage_id}-content-review.md"
    review_relative = Path(".harness/runs") / run_dir.name / "reviews" / f"{stage.stage_id}-content-review.md"
    return f"""Use the `artifact_reviewer` agent and $harness-artifact-reviewer to independently review `{stage.stage_id}` content.

Review content correctness, completeness, and stage-boundary fit. Do not only check file shape. Do not edit stage artifacts.
Write one review report to `{review_relative}`.

Return only JSON with keys: status, questions, review_file, findings, blocker.

Status rules:
- `complete`: content review approved the artifacts for this stage.
- `needs_input`: content has ambiguity that can be resolved by asking the user; ask up to 3 questions.
- `blocked`: content is invalid due to missing/contradictory upstream input or a blocking finding that cannot be fixed by user answers in this stage.

Question rules:
- Ask at most 3 focused questions in `questions`.
- Every question must have `question` and `recommended`.
- Ask only questions inside this stage boundary.
- Do not ask any question already answered in answer history.

Review report rules:
- First non-heading status line must be `Review Status: approved` for `complete`.
- First non-heading status line must be `Review Status: rejected` for `needs_input` or `blocked`.
- Include `Blocking Findings`, `Nonblocking Findings`, and `Reviewed Inputs` sections.

Stage boundary:
{_interactive_stage_boundary(stage.stage_id)}

ChangeSet: {args.change_set_id}
UC: {uc_id or "-"}

Inputs:
{chr(10).join(f"- {path}" for path in inputs)}

Outputs to review:
{chr(10).join(f"- {path}" for path in outputs)}

Stage changed files:
{_json_dumps_utf8_safe(stage_result.get("changed_files", []))}

Answer history:
{_json_dumps_utf8_safe(session.get("answers", []))}

JSON examples:
{{"status":"complete","questions":[],"review_file":"{review_relative}","findings":[],"blocker":""}}
{{"status":"needs_input","questions":[{{"question":"Which success condition is canonical?","recommended":"Use the user-visible outcome in docs/design/요구사항.md."}}],"review_file":"{review_relative}","findings":["Ambiguous success condition."],"blocker":""}}
{{"status":"blocked","questions":[],"review_file":"{review_relative}","findings":["Use case contradicts confirmed requirement."],"blocker":"Use case contradicts confirmed requirement."}}
"""


def _interactive_stage_boundary(stage_id: str) -> str:
    boundaries = {
        "requirements-definition": (
            "- Owns actor, goal, user-visible success condition, user-visible failure policy, "
            "hard scope boundary, and business policy decisions.\n"
            "- Do not ask canonical naming, DDD, event naming, infrastructure, or implementation strategy questions."
        ),
        "ubiquitous-language-definition": (
            "- Owns canonical term, Korean label, English/code-facing label, aliases, forbidden terms, and meaning boundary.\n"
            "- Do not ask whether a domain object, note type, source rule, MVP policy, actor goal, success condition, "
            "failure policy, or hard scope belongs in the product; those are upstream requirements/use-case decisions.\n"
            "- If upstream requirements omit or contradict a decision needed for language confirmation, report a blocker instead of asking a Grill-Me question.\n"
            "- Ask only when canonical wording, labels, aliases, forbidden terms, or exact term meaning are unclear."
        ),
        "use-case-definition": (
            "- Owns use-case correctness, actor goal flow, runtime slice readiness, and E2E goal clarity.\n"
            "- Do not change requirements or context.md; report upstream blocker if those inputs are not ready."
        ),
        "event-storming": (
            "- Owns commands, events, policies, systems, external systems, and invariants for selected UC.\n"
            "- Do not ask DDD aggregate or technical strategy questions; defer those downstream."
        ),
    }
    return boundaries.get(stage_id, "- Follow stage skill boundary.")


def _exec_stage_grill_me_prompt(root: Path, step_dir: Path, prompt: str, label: str) -> str:
    step_dir.mkdir(parents=True, exist_ok=True)
    final_message_path = step_dir / "final-message.md"
    prompt_path = step_dir / "prompt.md"
    prompt = _utf8_safe_text(prompt)
    prompt_path.write_text(prompt, encoding="utf-8")
    command = [
        "codex",
        "exec",
        "--cd",
        str(root),
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
        "--sandbox",
        "workspace-write",
        "--output-last-message",
        str(final_message_path),
        "-",
    ]
    completed = subprocess.run(
        command,
        cwd=root,
        input=prompt,
        text=True,
        capture_output=True,
        timeout=300,
        check=False,
    )
    (step_dir / "stdout.txt").write_text(_utf8_safe_text(completed.stdout), encoding="utf-8")
    (step_dir / "stderr.txt").write_text(_utf8_safe_text(completed.stderr), encoding="utf-8")
    if completed.returncode != 0:
        error = _utf8_safe_text(completed.stderr).strip() or _utf8_safe_text(completed.stdout).strip()
        raise ValueError(f"{label} failed: {error}")
    return _utf8_safe_text(final_message_path.read_text(encoding="utf-8"))


def _exec_stage_review_prompt(root: Path, step_dir: Path, prompt: str, label: str) -> str:
    return _exec_stage_grill_me_prompt(root, step_dir, prompt, label)


def _parse_interactive_stage_json(text: str) -> dict:
    stripped = text.strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if match is None:
            raise ValueError(f"interactive stage returned non-JSON output: {stripped}")
        data = json.loads(match.group(0))
    if not isinstance(data, dict):
        raise ValueError("interactive stage returned invalid JSON object")

    status = str(data.get("status", "") or "").strip().lower()
    if status not in {"needs_input", "complete", "blocked"}:
        raise ValueError(f"interactive stage returned invalid status: {status or '<empty>'}")

    raw_questions = data.get("questions", [])
    if not isinstance(raw_questions, list):
        raise ValueError("interactive stage returned invalid questions")
    questions: list[dict[str, str]] = []
    for item in raw_questions[:3]:
        if not isinstance(item, dict):
            continue
        question = _utf8_safe_text(item.get("question", "") or "").strip()
        recommended = _utf8_safe_text(item.get("recommended", "") or "").strip()
        if question:
            questions.append({"question": question, "recommended": recommended})
    if status == "needs_input" and not questions:
        raise ValueError("interactive stage needs_input requires at least one question")

    changed_files = data.get("changed_files", [])
    if not isinstance(changed_files, list):
        raise ValueError("interactive stage returned invalid changed_files")
    return {
        "status": status,
        "questions": questions,
        "changed_files": [_utf8_safe_text(item) for item in changed_files],
        "blocker": _utf8_safe_text(data.get("blocker", "") or "").strip(),
    }


def _parse_interactive_review_json(text: str) -> dict:
    stripped = text.strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if match is None:
            raise ValueError(f"interactive content review returned non-JSON output: {stripped}")
        data = json.loads(match.group(0))
    if not isinstance(data, dict):
        raise ValueError("interactive content review returned invalid JSON object")

    status = str(data.get("status", "") or "").strip().lower()
    if status not in {"needs_input", "complete", "blocked"}:
        raise ValueError(f"interactive content review returned invalid status: {status or '<empty>'}")

    raw_questions = data.get("questions", [])
    if not isinstance(raw_questions, list):
        raise ValueError("interactive content review returned invalid questions")
    questions: list[dict[str, str]] = []
    for item in raw_questions[:3]:
        if not isinstance(item, dict):
            continue
        question = _utf8_safe_text(item.get("question", "") or "").strip()
        recommended = _utf8_safe_text(item.get("recommended", "") or "").strip()
        if question:
            questions.append({"question": question, "recommended": recommended})
    if status == "needs_input" and not questions:
        raise ValueError("interactive content review needs_input requires at least one question")

    raw_findings = data.get("findings", [])
    if not isinstance(raw_findings, list):
        raise ValueError("interactive content review returned invalid findings")

    return {
        "status": status,
        "questions": questions,
        "review_file": _utf8_safe_text(data.get("review_file", "") or "").strip(),
        "findings": [_utf8_safe_text(item) for item in raw_findings],
        "blocker": _utf8_safe_text(data.get("blocker", "") or "").strip(),
    }


def _save_interactive_stage_session(run_dir: Path, session: dict) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / "grill-me-session.json").write_text(
        _json_dumps_utf8_safe(session),
        encoding="utf-8",
    )


def _create_initial_procedure_changeset(
    repo_root: Path,
    change_set_path: Path,
    *,
    change_set_id: str,
    title: str,
    idea: str,
) -> None:
    target = repo_root / change_set_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title=_utf8_safe_text(title),
            request_summary=_utf8_safe_text(idea or title),
        ),
        encoding="utf-8",
    )


def _record_procedure_stage_status(
    repo_root: Path,
    change_set_path: Path,
    stage: ProcedureStage,
    status: str,
    notes: str,
) -> None:
    target = repo_root / change_set_path
    text = target.read_text(encoding="utf-8")
    target.write_text(
        update_changeset_stage_status(
            text,
            stage=stage,
            status=status,
            notes=notes,
        ),
        encoding="utf-8",
    )


def _format_procedure_stage_plan(
    stage: ProcedureStage,
    change_set_id: str,
    uc_id: str | None,
) -> str:
    inputs = replace_stage_placeholders(
        stage.inputs,
        change_set_id=change_set_id,
        uc_id=uc_id,
    )
    outputs = replace_stage_placeholders(
        stage.outputs,
        change_set_id=change_set_id,
        uc_id=uc_id,
    )
    lines = [
        f"Stage: {stage.stage_id}",
        f"Procedure: {stage.display_name}",
        f"Agent: {stage.agent_id or '-'}",
        f"Skill: {stage.skill_id or '-'}",
        "Inputs:",
        *[f"- {path}" for path in inputs],
        "Outputs:",
        *[f"- {path}" for path in outputs],
    ]
    return "\n".join(lines)


def _format_procedure_stage_verification(
    stage: ProcedureStage,
    passed: bool,
    problems: tuple[str, ...],
) -> str:
    lines = [
        f"Stage: {stage.stage_id}",
        f"Procedure: {stage.display_name}",
        f"Verification: {'passed' if passed else 'failed'}",
    ]
    if problems:
        lines.append("Problems:")
        lines.extend(f"- {problem}" for problem in problems)
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

    if _all_work_item_plans_completed(repo_root, scopes):
        try:
            run_id, completed_path = _complete_change_set_from_completed_plans(
                repo_root,
                change_set,
                scopes,
            )
        except ChangeSetCompletionBlocked as exc:
            return f"BLOCKED: {exc.reason}"
        return (
            f"APPLY completed: run_id={run_id} status={RunStatus.SUCCEEDED.value} "
            f"active_changeset_moved=true completed_path={completed_path}"
        )

    state, result = _apply_workflow(repo_root, change_set, scopes)
    return (
        f"APPLY started: run_id={state.run_id} status={result.status.value} "
        "active_changeset_moved=false"
    )


def evolution_propose_command(args: argparse.Namespace, repo_root: Path) -> str:
    try:
        proposal = propose_evolution(
            repo_root,
            change_set_id=args.change_set,
            work_item_id=args.work_item,
            run_id=args.run_id,
        )
    except EvolutionError as error:
        return f"Evolution proposal blocked: {error}"
    return "\n".join(
        [
            f"Evolution proposal created: {proposal.proposal_path}",
            f"Classification: {proposal.classification.status}",
            f"Target path: {proposal.target_path}",
            f"Experience: {proposal.experience_dir}",
        ]
    )


def evolution_accept_command(args: argparse.Namespace, repo_root: Path) -> str:
    try:
        accepted_path, target_path = accept_evolution(repo_root, args.proposal_id)
    except EvolutionError as error:
        return f"Evolution accept blocked: {error}"
    return "\n".join(
        [
            f"Evolution proposal accepted: {accepted_path}",
            f"Component updated: {target_path}",
        ]
    )


def evolution_reject_command(args: argparse.Namespace, repo_root: Path) -> str:
    try:
        proposal_path = reject_evolution(repo_root, args.proposal_id)
    except EvolutionError as error:
        return f"Evolution reject blocked: {error}"
    return f"Evolution proposal rejected: {proposal_path}"


def stages_list_command(args: argparse.Namespace, repo_root: Path) -> str:
    run_id = _latest_run_id_for_change_set(repo_root, args.change_set_id)
    if run_id is None:
        return "No run state found"
    state = RunStateStore(repo_root).load(run_id)
    table_rows = _procedure_table_rows_for_change_set(repo_root, args.change_set_id)
    table_by_stage = {row["id"]: row for row in table_rows}
    runtime_rows = runtime_stage_projection(state)
    drift_by_stage = {
        drift.stage: drift for drift in reconcile_procedure_stage_rows(state, table_rows)
    }
    rows = [
        f"RunState: {run_id}",
        "Stage\tStatus\tSource\tNotes",
    ]
    for stage in PROCEDURE_STAGES:
        runtime = runtime_rows.get(stage.stage_id)
        table = table_by_stage.get(stage.stage_id, {})
        status = runtime["status"] if runtime else table.get("status", "pending")
        source = "run_state" if runtime else "changeset"
        notes = runtime["notes"] if runtime else table.get("notes", "-")
        drift = drift_by_stage.get(stage.stage_id)
        if drift is not None:
            notes = f"{notes}; drift: runtime={drift.runtime_status} table={drift.table_status}"
        rows.append(f"{stage.stage_id}\t{status}\t{source}\t{notes}")
    return "\n".join(rows)


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


def dashboard_contracts_command(args: argparse.Namespace, repo_root: Path) -> str:
    return contract_dashboard_projection_json(
        repo_root,
        change_set_id=args.change_set,
    ).strip()


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


def _add_optional_mode_options(parser: argparse.ArgumentParser) -> None:
    mode = parser.add_mutually_exclusive_group(required=False)
    mode.add_argument("--plan", action="store_true")
    mode.add_argument("--preview", action="store_true")
    mode.add_argument(
        "--apply",
        action="store_true",
        help="Run workflows after creating the ChangeSet. Default for this command.",
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


def _procedure_table_rows_for_change_set(
    repo_root: Path,
    change_set_id: str,
) -> tuple[dict[str, str], ...]:
    for lifecycle in ("active", "completed"):
        path = repo_root / "docs/changes" / lifecycle / f"{change_set_id}.md"
        if path.exists():
            return parse_procedure_stage_rows(path.read_text(encoding="utf-8"))
    return ()


def _format_agent_context_result(result: AgentContextBootstrapResult) -> str:
    lines = [
        "Agent context:",
        f"- baseline AGENTS.md words: {result.baseline_agent_words}",
        f"- final AGENTS.md words: {result.final_agent_words}",
        f"- analyzer mode: {result.analyzer_mode}",
        f"- LLM summary: {result.llm_status}",
    ]
    if result.llm_error:
        lines.append(f"- LLM error: {result.llm_error}")
    lines.extend(f"- {item.path}: {item.action}" for item in result.files)
    return "\n".join(lines)


def _repo_description(value: str) -> str:
    text = value.strip()
    if text:
        return text
    return "Repository managed by the harness workflow."


def _all_work_item_plans_completed(repo_root: Path, scopes: tuple) -> bool:
    if not scopes:
        return False
    return all(
        (repo_root / _completed_plan_path(scope.display_id)).exists()
        and not (repo_root / _active_plan_path(scope)).exists()
        for scope in scopes
    )


def _complete_change_set_from_completed_plans(
    repo_root: Path,
    change_set: ChangeSet,
    scopes: tuple,
) -> tuple[str, Path]:
    run_id = f"run-{uuid4().hex[:12]}"
    affected_use_cases = tuple(
        scope.use_case.uc_id for scope in scopes if scope.use_case is not None
    )
    affected_work_items = tuple(scope.display_id for scope in scopes)
    work_item_states = tuple(
        WorkItemLoopState(
            work_item_id=scope.display_id,
            work_item_type=scope.work_item_type,
            active_plan_path=_active_plan_path(scope),
            status=RunStatus.SUCCEEDED,
            current_step_id="complete",
            verification_status=RunStatus.SUCCEEDED.value,
        )
        for scope in scopes
    )
    use_case_states = tuple(
        UseCaseLoopState(
            uc_id=scope.use_case.uc_id,
            active_plan_path=_active_plan_path(scope),
            status=RunStatus.SUCCEEDED,
        )
        for scope in scopes
        if scope.use_case is not None
    )
    RunStateStore(repo_root).save(
        RunState(
            run_id=run_id,
            change_set_id=change_set.change_set_id,
            workflow_name="changeset-use-case-workflow",
            mode=RunMode.APPLY,
            affected_use_cases=affected_use_cases,
            affected_work_items=affected_work_items,
            completed_use_cases=affected_use_cases,
            completed_work_items=affected_work_items,
            status=RunStatus.SUCCEEDED,
            use_case_states=use_case_states,
            work_item_states=work_item_states,
        )
    )
    ReportWriter(repo_root).write(
        RunReport(
            run_id=run_id,
            change_set_id=change_set.change_set_id,
            workflow_name="changeset-use-case-workflow",
            mode=RunMode.APPLY,
            status=RunStatus.SUCCEEDED,
            affected_use_cases=affected_use_cases,
            completed_use_cases=affected_use_cases,
            work_item_reports=tuple(
                WorkItemReport(
                    work_item_id=scope.display_id,
                    work_item_type=scope.work_item_type,
                    active_plan_path=_active_plan_path(scope),
                    completed_plan_path=_completed_plan_path(scope.display_id),
                    status=RunStatus.SUCCEEDED,
                    current_stage="complete",
                    verification_goal_path=scope.verification_goal_path,
                    verification_result=RunStatus.SUCCEEDED.value,
                )
                for scope in scopes
            ),
        )
    )
    completion = complete_change_set_if_ready(repo_root, change_set, run_id=run_id)
    return run_id, completion.completed_path


def _active_plan_path(scope) -> Path:
    return scope.plan_path or Path(f"docs/plans/active/{scope.display_id}/plan.md")


def _completed_plan_path(work_item_id: str) -> Path:
    return Path(f"docs/plans/completed/{work_item_id}/plan.md")


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
    final_scope = None
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
        final_scope = scope
        if scope_result.status != RunStatus.SUCCEEDED:
            break

    if final_result is None:
        raise RuntimeError("workflow execution requires at least one ChangeSet work item")

    current_scope = final_scope or scopes[0]
    state = RunState(
        run_id=run_id,
        change_set_id=change_set.change_set_id,
        workflow_name=workflow.name,
        mode=RunMode.APPLY,
        affected_use_cases=affected_use_cases,
        affected_work_items=affected_work_items,
        current_use_case_id=(
            current_scope.use_case.uc_id if current_scope.use_case is not None else None
        ),
        current_work_item_id=current_scope.display_id,
        status=final_result.status,
        failure_kind=_run_failure_kind(final_result.failure_kind),
        decision_results=_workflow_decision_results(result_by_work_item),
        work_item_states=tuple(
            WorkItemLoopState(
                work_item_id=scope.display_id,
                work_item_type=scope.work_item_type,
                active_plan_path=scope.plan_path
                or Path(f"docs/plans/active/{scope.display_id}/plan.md"),
                status=result_by_work_item.get(scope.display_id, final_result).status,
                current_step_id=scope.current_stage,
                verification_status=result_by_work_item.get(scope.display_id, final_result).status.value,
                retry_count=result_by_work_item.get(scope.display_id, final_result).retry_count,
                failure_kind=_run_failure_kind(
                    result_by_work_item.get(scope.display_id, final_result).failure_kind
                ),
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
                retry_count=result_by_work_item.get(scope.display_id, final_result).retry_count,
                failure_kind=_run_failure_kind(
                    result_by_work_item.get(scope.display_id, final_result).failure_kind
                ),
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


def _run_failure_kind(failure_kind: FailureKind | None) -> RunFailureKind | None:
    if failure_kind == FailureKind.IMPLEMENTATION:
        return RunFailureKind.IMPLEMENTATION_FAILURE
    if failure_kind == FailureKind.UPSTREAM_DESIGN:
        return RunFailureKind.UPSTREAM_DESIGN_CONFLICT
    if failure_kind == FailureKind.ENVIRONMENT_BLOCKER:
        return RunFailureKind.ENVIRONMENT_BLOCKER
    if failure_kind == FailureKind.UNCLEAR_E2E_GOAL:
        return RunFailureKind.UNCLEAR_E2E_GOAL
    if failure_kind == FailureKind.DOCUMENT_DELTA_CONFLICT:
        return RunFailureKind.DOCUMENT_DELTA_CONFLICT
    if failure_kind == FailureKind.SCOPE_CONFLICT:
        return RunFailureKind.SCOPE_CONFLICT
    if failure_kind == FailureKind.VERIFICATION_GOAL_UNCLEAR:
        return RunFailureKind.VERIFICATION_GOAL_UNCLEAR
    if failure_kind == FailureKind.UNKNOWN:
        return RunFailureKind.UNCLEAR_E2E_GOAL
    return None


def _workflow_decision_results(result_by_work_item: Mapping[str, RunResult]) -> dict[str, object]:
    decisions: dict[str, object] = {}
    for work_item_id, result in result_by_work_item.items():
        item_decisions = tuple(result.metadata.get("decisions", ()))
        if item_decisions:
            decisions[work_item_id] = item_decisions
    return decisions


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
