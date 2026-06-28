"""CLI entrypoint for ChangeSet and use-case workflow commands."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import replace as dataclass_replace
from datetime import datetime
from pathlib import Path
from typing import Mapping
from uuid import uuid4

import yaml

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
from harness_codex.runtime.changes.parser import parse_changeset_markdown
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
from harness_codex.runtime.memory import (
    MemoryError,
    load_memory_entries,
    score_memory_candidate,
    search_memory,
)
from harness_codex.runtime.preflight import run_workflow_preflight, write_preflight_result
from harness_codex.runtime.procedure_stages import (
    PROCEDURE_STAGES,
    ProcedureStage,
    parse_procedure_stage_rows,
    procedure_stage,
    render_initial_changeset,
    replace_stage_placeholders,
    stage_outputs_for_run,
    update_changeset_stage_status,
    verify_procedure_stage,
)
from harness_codex.runtime.app_runner import (
    DEFAULT_READINESS_TIMEOUT_SECONDS,
    app_status,
    attach_app,
    run_app,
    start_app,
    stop_app,
)
from harness_codex.runtime.reset import format_result as format_reset_result
from harness_codex.runtime.reset import run_reset
from harness_codex.runtime.self_update import DEFAULT_REF, DEFAULT_REPO, run_self_update
from harness_codex.runtime.shell_completion import install_completion as install_shell_completion
from harness_codex.runtime.ui_server import (
    rerun_ddd_architecture_step_changeset,
    run_all_ddd_architecture_changeset,
    run_ui_server,
)
from harness_codex.runtime.wiki_runner import run_wiki
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
        "technical-decisions",
    }
)

DESIGN_STAGE_IDS = frozenset(
    {
        "requirements-definition",
        "ubiquitous-language-definition",
        "use-case-definition",
        "event-storming",
        "ddd-architecture-definition",
        "technical-decisions",
    }
)

INTERACTIVE_CODEX_EXEC_TIMEOUT_SECONDS = 3600
PROCEDURE_STAGE_TIMEOUT_SECONDS = 3600
IMPLEMENTATION_STAGE_TIMEOUT_SECONDS = 7200


def _procedure_stage_timeout_sec(stage_id: str) -> int:
    default_timeout = (
        IMPLEMENTATION_STAGE_TIMEOUT_SECONDS
        if stage_id == "implementation"
        else PROCEDURE_STAGE_TIMEOUT_SECONDS
    )
    return int(
        os.environ.get("HARNESS_PROCEDURE_STAGE_TIMEOUT_SECONDS", str(default_timeout))
    )


COMMAND_HELP: tuple[tuple[str, str], ...] = (
    ("help", "Show runtime help."),
    ("init", "Initialize repo-local agent context files."),
    ("agent-context", "Initialize repo-local agent context files."),
    ("changes", "List, inspect, create, delete, or continue ChangeSets."),
    ("contracts", "Validate document handoff contracts."),
    ("completion", "Install shell completion."),
    ("run", "Run repository-local application and wiki commands."),
    ("requirements-definition", "Define requirements and finalize temp ChangeSet when needed."),
    ("ubiquitous-language-definition", "Define project ubiquitous language."),
    ("use-case-definition", "Define use cases."),
    ("event-storming", "Create event storming for one use case."),
    ("ddd-architecture-definition", "Create DDD architecture for one use case."),
    ("technical-decisions", "Record technical decisions for one use case."),
    ("plan-writing", "Write implementation plan for one use case."),
    ("implementation", "Run one ChangeSet through UC-scoped implementation loops."),
    ("ultrawork", "Create a ChangeSet and run affected workflows."),
    ("evolution", "Manage evolution proposals."),
    ("memory", "List, search, and score file-backed long-term memory."),
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
        "       harness changes show|delete|contents|continue <CHG-ID>\n"
        "       harness changes document-delta <CHG-ID> --uc UC-ID --summary TEXT --plan|--preview|--apply"
    ),
    "contracts": "Usage: harness contracts validate <CHG-ID> [--work-item ID] [--json]",
    "completion": "Usage: harness completion install [--shell auto|zsh|bash|all]",
    "run": (
        "Usage: harness run app [--timeout SECONDS] [-- SERVER_ARG ...]\n"
        "       harness run app --foreground [-- APP_ARG ...]\n"
        "       harness run app status|stop|attach infra|server\n"
        "       harness run wiki [serve|build|install] [--dev-addr HOST:PORT]"
    ),
    "requirements-definition": "Usage: harness requirements-definition [CHG-ID]",
    "ubiquitous-language-definition": "Usage: harness ubiquitous-language-definition <CHG-ID>",
    "use-case-definition": "Usage: harness use-case-definition <CHG-ID>",
    "event-storming": "Usage: harness event-storming <CHG-ID> --uc UC-ID",
    "ddd-architecture-definition": (
        "Usage: harness ddd-architecture-definition <CHG-ID> --uc UC-ID\n"
        "       harness ddd-architecture-definition <CHG-ID> --all\n"
        "       harness ddd-architecture-definition <CHG-ID> --uc UC-ID --rerun-step STEP [--prompt TEXT]"
    ),
    "technical-decisions": "Usage: harness technical-decisions <CHG-ID> --uc UC-ID",
    "plan-writing": "Usage: harness plan-writing <CHG-ID> --uc UC-ID",
    "implementation": (
        "Usage: harness implementation <CHG-ID> "
        "[--uc WORK-ITEM-ID] [--force-verification] --plan|--preview|--apply"
    ),
    "ultrawork": (
        "Usage: harness ultrawork [--title TEXT] [--change-set-id ID] "
        "[--uc UC-ID] [--force] [--plan|--preview|--apply]"
    ),
    "evolution": "Usage: harness evolution propose|accept|reject ...",
    "memory": (
        "Usage: harness memory list [--all]\n"
        "       harness memory search QUERY [--all]\n"
        "       harness memory score CANDIDATE.yaml"
    ),
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
        MemoryError,
        ValueError,
    ) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if isinstance(output, int):
        return output
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
    changes_continue = changes_subparsers.add_parser("continue")
    changes_continue.add_argument("change_set_id")
    changes_continue.add_argument(
        "--uc",
        default="",
        help="Use a specific affected UC for the next UC-scoped stage.",
    )
    changes_continue.add_argument(
        "--blocker-resolution",
        choices=("requirements", "use-case"),
        default="",
        help=(
            "Resolve an upstream use-case blocker by returning to requirements "
            "or updating current use-case artifacts."
        ),
    )
    changes_continue.add_argument(
        "--resolution-prompt",
        default="",
        help="Prompt used when --blocker-resolution use-case is selected.",
    )
    changes_continue.add_argument(
        "--force-verification",
        action="store_true",
        help="Run all implementation verification commands instead of reusing PASS evidence.",
    )
    _add_mode_options(changes_continue)
    changes_continue.set_defaults(func=changes_continue_command)
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

    run = subparsers.add_parser("run")
    run_subparsers = run.add_subparsers(required=True)
    run_app_parser = run_subparsers.add_parser("app")
    run_app_parser.add_argument("--foreground", action="store_true")
    run_app_parser.add_argument(
        "--timeout",
        type=int,
        default=DEFAULT_READINESS_TIMEOUT_SECONDS,
    )
    run_app_parser.add_argument("app_args", nargs=argparse.REMAINDER)
    run_app_parser.set_defaults(func=run_app_command)
    run_wiki_parser = run_subparsers.add_parser("wiki")
    run_wiki_parser.add_argument(
        "wiki_action",
        nargs="?",
        choices=("serve", "build", "install"),
        default="serve",
    )
    run_wiki_parser.add_argument("--dev-addr", default="127.0.0.1:8000")
    run_wiki_parser.set_defaults(func=run_wiki_command)

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
    ultrawork.add_argument(
        "--request",
        default="",
        help="Plain feature request used to create canonical design docs before bridging.",
    )
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

    memory = subparsers.add_parser("memory")
    memory_subparsers = memory.add_subparsers(required=True)
    memory_list = memory_subparsers.add_parser("list")
    memory_list.add_argument("--all", action="store_true")
    memory_list.set_defaults(func=memory_list_command)
    memory_search = memory_subparsers.add_parser("search")
    memory_search.add_argument("query")
    memory_search.add_argument("--all", action="store_true")
    memory_search.set_defaults(func=memory_search_command)
    memory_score = memory_subparsers.add_parser("score")
    memory_score.add_argument("candidate_path")
    memory_score.set_defaults(func=memory_score_command)

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
    if stage.stage_id == "ddd-architecture-definition":
        command.add_argument(
            "--all",
            action="store_true",
            help="Run every remaining DDD architecture substep for all affected use cases.",
        )
        command.add_argument(
            "--rerun-step",
            choices=(
                "entity_vo",
                "behaviors",
                "application_flow",
                "aggregates",
                "bounded_contexts",
            ),
            default="",
            help="Rerun one DDD architecture substep for --uc.",
        )
        command.add_argument(
            "--prompt",
            default="",
            help="Optional correction prompt for --rerun-step.",
        )
    command.add_argument("--title", default="")
    command.add_argument("--idea", default="")
    command.add_argument(
        "--force",
        action="store_true",
        help="Rerun the stage even when the ChangeSet table marks it verified.",
    )
    if stage.stage_id == "implementation":
        command.add_argument(
            "--force-verification",
            action="store_true",
            help="Run all verification commands instead of reusing compatible PASS evidence.",
        )
        command.add_argument(
            "--rollback",
            choices=("none", "safe", "git"),
            default="none",
            help=(
                "Rollback behavior on failed mutating steps. Default preserves "
                "all files and writes a rollback report."
            ),
        )
    if stage.stage_id in DESIGN_STAGE_IDS:
        command.set_defaults(plan=False, preview=False, apply=True)
    elif stage.stage_id == "plan-writing":
        command.set_defaults(plan=False, preview=False, apply=True)
    else:
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


def run_app_command(args: argparse.Namespace, repo_root: Path) -> str | int | None:
    app_args = list(args.app_args)
    if app_args == ["status"]:
        return app_status(repo_root)
    if app_args == ["stop"]:
        return stop_app(repo_root)
    if app_args[:1] == ["attach"]:
        if len(app_args) != 2:
            raise ValueError("usage: harness run app attach infra|server")
        attach_app(repo_root, app_args[1])
        return None
    if app_args[:1] == ["--"]:
        app_args = app_args[1:]
    if args.foreground:
        return run_app(repo_root, app_args)
    return start_app(repo_root, app_args, timeout=args.timeout)


def run_wiki_command(args: argparse.Namespace, repo_root: Path) -> int:
    return run_wiki(
        repo_root,
        args.wiki_action,
        dev_addr=args.dev_addr,
    )


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


def changes_continue_command(args: argparse.Namespace, repo_root: Path) -> str:
    mode = _selected_mode(args)
    change_set = _load_change_set(repo_root, args.change_set_id)
    decision = _decide_changes_continue_target(
        repo_root,
        change_set,
        uc_override=args.uc.strip() or None,
    )
    resolution_prompt = ""
    if decision.get("requires_blocker_resolution"):
        resolution = args.blocker_resolution
        if not resolution:
            if mode != RunMode.APPLY:
                return _format_use_case_blocker_resolution_required(change_set.change_set_id)
            resolution = _read_use_case_blocker_resolution()

        if resolution == "requirements":
            decision = {
                "stage_id": "requirements-definition",
                "uc_id": None,
                "force": True,
                "blocked": False,
                "reason": "user chose to supplement upstream requirements",
            }
        else:
            resolution_prompt = args.resolution_prompt.strip()
            if not resolution_prompt:
                if mode != RunMode.APPLY:
                    return (
                        "BLOCKED: --resolution-prompt is required with "
                        "--blocker-resolution use-case"
                    )
                resolution_prompt = input("Prompt for use-case artifact update: ").strip()
            if not resolution_prompt:
                raise ValueError("resolution prompt is required")
            decision = {
                "stage_id": "use-case-definition",
                "uc_id": None,
                "force": True,
                "blocked": False,
                "reason": "user chose to update current use-case artifacts",
            }
    if decision["blocked"]:
        return f"BLOCKED: {decision['reason']}"

    stage = procedure_stage(decision["stage_id"])
    stage_args = argparse.Namespace(
        procedure_stage_id=stage.stage_id,
        change_set_id=change_set.change_set_id,
        uc=decision["uc_id"] or "",
        title="",
        idea=resolution_prompt,
        force=decision["force"],
        plan=mode == RunMode.PLAN,
        preview=mode == RunMode.PREVIEW,
        apply=mode == RunMode.APPLY,
        force_verification=args.force_verification,
    )
    header = [
        f"Continue: {change_set.change_set_id}",
        f"Target stage: {stage.stage_id}",
        f"UC: {decision['uc_id'] or '-'}",
        f"Reason: {decision['reason']}",
    ]
    result = procedure_stage_command(stage_args, repo_root)
    return "\n".join([*header, result])


def _format_use_case_blocker_resolution_required(change_set_id: str) -> str:
    return "\n".join(
        [
            f"BLOCKED: {change_set_id} use-case-definition needs user resolution",
            "Options:",
            "1. Return to requirements-definition and supplement requirements.",
            "2. Stay in use-case-definition and update current artifacts using a prompt.",
            "Apply with --blocker-resolution requirements, or",
            "apply with --blocker-resolution use-case --resolution-prompt TEXT.",
        ]
    )


def _read_use_case_blocker_resolution() -> str:
    print("Use-case stage is blocked by an upstream requirements decision.")
    print("1. Return to requirements-definition and supplement requirements.")
    print("2. Stay in use-case-definition and update current artifacts using a prompt.")
    while True:
        answer = input("Selection [1/2]: ").strip().lower()
        if answer in {"1", "requirements"}:
            return "requirements"
        if answer in {"2", "use-case", "usecase"}:
            return "use-case"
        print("Enter 1 or 2.")


def _decide_changes_continue_target(
    repo_root: Path,
    change_set: ChangeSet,
    *,
    uc_override: str | None,
) -> dict[str, object]:
    rows = _procedure_table_rows_for_change_set(repo_root, change_set.change_set_id)
    rows_by_stage = {row.get("id", ""): row for row in rows}
    blocked = _first_procedure_row_with_status(rows_by_stage, "blocked")
    if blocked is not None:
        stage_id = blocked.get("id", "")
        notes = blocked.get("notes", "")
        if stage_id == "use-case-definition" and _notes_require_requirements_rerun(notes):
            requirements_row = rows_by_stage.get("requirements-definition")
            if _stage_updated_after(requirements_row, blocked):
                return {
                    "stage_id": "use-case-definition",
                    "uc_id": None,
                    "force": True,
                    "blocked": False,
                    "reason": "requirements-definition was rerun after the upstream blocker",
                }
            return {
                "stage_id": "",
                "uc_id": None,
                "force": False,
                "blocked": False,
                "requires_blocker_resolution": True,
                "reason": "use-case-definition needs user blocker resolution",
            }
        stale_upstream = _first_stale_verified_stage(
            repo_root,
            change_set,
            rows_by_stage,
            uc_override=uc_override,
            stop_before_stage_id=stage_id,
        )
        if stale_upstream:
            return stale_upstream
        return {
            "stage_id": stage_id,
            "uc_id": _continue_uc_for_stage(repo_root, change_set, stage_id, uc_override),
            "force": True,
            "blocked": False,
            "reason": f"{stage_id} is blocked and should be rerun",
        }

    for stage in PROCEDURE_STAGES:
        row = rows_by_stage.get(stage.stage_id)
        uc_id = _continue_uc_for_stage(repo_root, change_set, stage.stage_id, uc_override)
        if (
            row is not None
            and row.get("status") == "verified"
            and (stage.requires_uc or stage.stage_id == "implementation")
        ):
            passed, problems = _verify_procedure_stage_for_changeset(
                repo_root,
                stage,
                change_set_id=change_set.change_set_id,
                uc_id=uc_id,
            )
            if passed:
                continue
            return {
                "stage_id": stage.stage_id,
                "uc_id": uc_id,
                "force": True,
                "blocked": False,
                "reason": (
                    f"{stage.stage_id} verified state is stale: "
                    + "; ".join(problems)
                ),
            }
        if row is not None and row.get("status") == "verified":
            continue
        if stage.requires_uc and not uc_id:
            return {
                "stage_id": stage.stage_id,
                "uc_id": None,
                "force": False,
                "blocked": True,
                "reason": f"{stage.stage_id} requires an affected UC or --uc",
            }
        return {
            "stage_id": stage.stage_id,
            "uc_id": uc_id,
            "force": False,
            "blocked": False,
            "reason": f"{stage.stage_id} is the next incomplete stage",
        }

    return {
        "stage_id": "",
        "uc_id": None,
        "force": False,
        "blocked": True,
        "reason": "all procedure stages are verified",
    }


def _first_stale_verified_stage(
    repo_root: Path,
    change_set: ChangeSet,
    rows_by_stage: Mapping[str, dict[str, str]],
    *,
    uc_override: str | None,
    stop_before_stage_id: str,
) -> dict[str, object] | None:
    for stage in PROCEDURE_STAGES:
        if stage.stage_id == stop_before_stage_id:
            return None
        row = rows_by_stage.get(stage.stage_id)
        if row is None or row.get("status") != "verified":
            continue
        if not stage.requires_uc and stage.stage_id != "implementation":
            continue
        uc_id = _continue_uc_for_stage(repo_root, change_set, stage.stage_id, uc_override)
        passed, problems = verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=change_set.change_set_id,
            uc_id=uc_id,
        )
        if not passed:
            return {
                "stage_id": stage.stage_id,
                "uc_id": uc_id,
                "force": True,
                "blocked": False,
                "reason": (
                    f"{stage.stage_id} verified state is stale: "
                    + "; ".join(problems)
                ),
            }
    return None


def _first_procedure_row_with_status(
    rows_by_stage: Mapping[str, dict[str, str]],
    status: str,
) -> dict[str, str] | None:
    for stage in PROCEDURE_STAGES:
        row = rows_by_stage.get(stage.stage_id)
        if row is not None and row.get("status") == status:
            return row
    return None


def _notes_require_requirements_rerun(notes: str) -> bool:
    normalized = notes.lower()
    return (
        "requirements do not define" in normalized
        or "upstream requirements decision" in normalized
        or "requirements decision" in normalized
        or "requirements omit" in normalized
        or "requirements missing" in normalized
    )


def _stage_updated_after(
    newer_row: dict[str, str] | None,
    older_row: dict[str, str],
) -> bool:
    if newer_row is None:
        return False
    newer = newer_row.get("verified_at", "")
    older = older_row.get("verified_at", "")
    return bool(newer and older and newer > older)


def _continue_uc_for_stage(
    repo_root: Path,
    change_set: ChangeSet,
    stage_id: str,
    uc_override: str | None,
) -> str | None:
    stage = procedure_stage(stage_id)
    if not stage.requires_uc:
        return None
    if uc_override:
        return uc_override
    uc_ids = _change_set_use_case_ids(repo_root, change_set)
    if uc_ids:
        for uc_id in uc_ids:
            passed, _problems = verify_procedure_stage(
                repo_root,
                stage,
                change_set_id=change_set.change_set_id,
                uc_id=uc_id,
            )
            if not passed:
                return uc_id
        return uc_ids[0]
    return None


def _change_set_use_case_ids(repo_root: Path, change_set: ChangeSet) -> tuple[str, ...]:
    affected = tuple(use_case.uc_id for use_case in change_set.affected_use_cases)
    if affected:
        return affected
    path = repo_root / "docs/changes/active" / f"{change_set.change_set_id}.ddd-integration.json"
    if not path.exists():
        return ()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return ()
    candidates = payload.get("candidate_inputs")
    if not isinstance(candidates, list):
        return ()
    ids: list[str] = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        uc_id = candidate.get("uc_id")
        if isinstance(uc_id, str) and uc_id.startswith("UC-") and uc_id not in ids:
            ids.append(uc_id)
    return tuple(ids)


def _verify_procedure_stage_for_changeset(
    repo_root: Path,
    stage: ProcedureStage,
    *,
    change_set_id: str,
    uc_id: str | None,
) -> tuple[bool, tuple[str, ...]]:
    if not stage.requires_uc:
        return verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=change_set_id,
            uc_id=uc_id,
        )
    try:
        change_set = _load_change_set(repo_root, change_set_id)
    except (FileNotFoundError, ValueError):
        return verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=change_set_id,
            uc_id=uc_id,
        )
    uc_ids = _change_set_use_case_ids(repo_root, change_set)
    if not uc_ids:
        return verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=change_set_id,
            uc_id=uc_id,
        )

    problems: list[str] = []
    for affected_uc_id in uc_ids:
        passed, uc_problems = verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=change_set_id,
            uc_id=affected_uc_id,
        )
        if not passed:
            problems.extend(uc_problems)
    return not problems, tuple(problems)


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
    request = str(getattr(args, "request", "") or "").strip()
    if request:
        if not args.title:
            args.title = _title_from_request(request)
        _create_design_docs_from_request(
            repo_root,
            title=args.title,
            request=request,
            force=bool(args.force),
        )
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


def _create_design_docs_from_request(
    repo_root: Path,
    *,
    title: str,
    request: str,
    force: bool,
) -> None:
    requirements_path = repo_root / "docs/design/요구사항.md"
    use_cases_path = repo_root / "docs/design/유스케이스.md"
    existing = [path for path in (requirements_path, use_cases_path) if path.exists()]
    if existing and not force:
        relative = ", ".join(str(path.relative_to(repo_root)) for path in existing)
        raise DesignBridgeError(
            "Design docs already exist; pass --force to regenerate from --request: "
            f"{relative}"
        )
    requirements_path.parent.mkdir(parents=True, exist_ok=True)
    requirements_path.write_text(
        _render_request_requirements(title=title, request=request),
        encoding="utf-8",
    )
    use_cases_path.write_text(
        _render_request_use_cases(title=title, request=request),
        encoding="utf-8",
    )


def _title_from_request(request: str) -> str:
    words = " ".join(request.strip().split())
    if not words:
        raise ValueError("request is required")
    return words[:80].rstrip(". ")


def _render_request_requirements(*, title: str, request: str) -> str:
    return f"""# Requirements Specification

## 1. Overview

- Initial idea: {request}
- Goal: {title}

## 2. Scope

- Build the requested capability as described by the initial idea.
- Preserve existing repository behavior outside the generated ChangeSet scope.

## 3. Functional Requirements

### 3.1 Requested Capability

- FR-001. The system shall support the requested capability: {request}
- FR-002. The system shall reject invalid or unsupported input without corrupting state.
- FR-003. The system shall expose observable success and failure behavior for verification.

## 4. Non-Functional Requirements

- NFR-001. The implementation shall be testable through the repository verification gate.
- NFR-002. The implementation shall keep generated documents and runtime artifacts auditable.
"""


def _render_request_use_cases(*, title: str, request: str) -> str:
    return f"""# Use Case Document

## 1. Actor Definition

### Primary Actor

- User

## 2. High-Level Use Case List

### User

- UC-001. User completes requested capability

## 3. Use Case Details

## UC-001. User completes requested capability

**Actor**

- User

**Goal**

- Complete the requested capability: {title}

**Basic Flow**

1. The user starts the requested capability.
2. The system accepts valid input for: {request}
3. The system produces the expected observable result.

**Exception Flow**

- Invalid or unsupported input is rejected.
- The system reports a recoverable error without corrupting state.
"""


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
    run_all = stage.stage_id == "ddd-architecture-definition" and getattr(args, "all", False)
    rerun_step = (
        str(getattr(args, "rerun_step", "") or "").strip()
        if stage.stage_id == "ddd-architecture-definition"
        else ""
    )
    if run_all and uc_id:
        raise ValueError("ddd-architecture-definition --all cannot be combined with --uc")
    if run_all and rerun_step:
        raise ValueError("ddd-architecture-definition --all cannot be combined with --rerun-step")
    if rerun_step and not uc_id:
        raise ValueError("ddd-architecture-definition --rerun-step requires --uc")
    if stage.stage_id == "implementation":
        args.change_set_id = _resolve_procedure_change_set_id(repo_root, args, mode)
        return run_change_command(args, repo_root)
    if stage.stage_id == "technical-decisions" and not uc_id:
        args.change_set_id = _resolve_procedure_change_set_id(repo_root, args, mode)
        change_set_path = Path("docs/changes/active") / f"{args.change_set_id}.md"
        if not (repo_root / change_set_path).exists():
            return f"BLOCKED: ChangeSet does not exist: {change_set_path}"
        return _run_all_technical_decisions_stage(args, repo_root, mode)

    if stage.requires_uc and not uc_id and not run_all:
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

    if run_all:
        payload = run_all_ddd_architecture_changeset(repo_root, args.change_set_id)
        harvest = payload["harvest"]
        state = harvest.get("ddd_architecture", {})
        lines = [
            "Stage: ddd-architecture-definition",
            "Mode: run-all",
            f"Completed: {state.get('completed_count', 0)} / {state.get('total_count', 0)}",
            f"Status: {state.get('status', 'unknown')}",
        ]
        if state.get("current_uc"):
            lines.append(f"Current UC: {state['current_uc']}")
        if state.get("current_step"):
            lines.append(f"Current substep: {state['current_step']}")
        question = harvest.get("current_question")
        if isinstance(question, dict) and question.get("question"):
            lines.append(f"Question: {question['question']}")
        if harvest.get("runtime_error"):
            lines.append(f"Error: {harvest['runtime_error']}")
        return "\n".join(lines)

    if rerun_step:
        payload = rerun_ddd_architecture_step_changeset(
            repo_root,
            args.change_set_id,
            uc_id or "",
            rerun_step,
            getattr(args, "prompt", "") or "",
        )
        harvest = payload["harvest"]
        state = harvest.get("ddd_architecture", {})
        item = state.get("items", {}).get(uc_id or "", {})
        step = item.get("steps", {}).get(rerun_step, {})
        lines = [
            "Stage: ddd-architecture-definition",
            "Mode: rerun-step",
            f"UC: {uc_id}",
            f"Substep: {rerun_step}",
            f"Status: {step.get('status', state.get('status', 'unknown'))}",
            f"Completed: {state.get('completed_count', 0)} / {state.get('total_count', 0)}",
        ]
        question = step.get("current_question")
        if isinstance(question, dict) and question.get("question"):
            lines.append(f"Question: {question['question']}")
        if step.get("error"):
            lines.append(f"Error: {step['error']}")
        elif harvest.get("runtime_error"):
            lines.append(f"Error: {harvest['runtime_error']}")
        return "\n".join(lines)

    if mode == RunMode.PREVIEW:
        passed, problems = verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=args.change_set_id,
            uc_id=uc_id,
        )
        return _format_procedure_stage_verification(stage, passed, problems)

    if not getattr(args, "force", False):
        already_verified = _format_already_verified_procedure_stage(
            repo_root,
            change_set_path,
            stage,
            change_set_id=args.change_set_id,
            uc_id=uc_id,
        )
        if already_verified:
            return already_verified

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
        active_plan_path=(
            Path("docs/plans/active") / uc_id / "plan.md"
            if uc_id
            else Path("docs/plans/active/plan.md")
        ),
        metadata={
            "change_set_id": args.change_set_id,
            "procedure_stage": stage.stage_id,
            "uc_id": uc_id,
            "active_work_item_id": uc_id or "",
            "idea": args.idea,
        },
    )
    step_metadata: dict[str, object] = {"procedure_stage": stage.stage_id}
    if stage.stage_id == "use-case-definition" and uc_id:
        step_metadata["target_uc"] = uc_id
        step_metadata["slice_outputs"] = {
            "root": "docs/use-cases",
            "required_per_use_case": ["use-case.md", "e2e-goal.md"],
        }

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
        outputs=stage_outputs_for_run(
            stage,
            change_set_id=args.change_set_id,
            uc_id=uc_id,
        ),
        timeout_sec=_procedure_stage_timeout_sec(stage.stage_id),
        metadata=step_metadata,
    )
    result = BasicStepRunner().run(step, context)
    passed, problems = verify_procedure_stage(
        repo_root,
        stage,
        change_set_id=args.change_set_id,
        uc_id=uc_id,
    )
    status = "verified" if result.successful and passed else "blocked"
    verification_notes = "; ".join(problems)
    notes = (
        verification_notes
        if result.successful
        else "; ".join(part for part in (result.error, verification_notes) if part)
    ) or "-"
    _record_procedure_stage_status(repo_root, change_set_path, stage, status, notes)
    lines = [
        f"Stage: {stage.stage_id}",
        f"Run: {run_id}",
        f"Agent status: {result.status.value}",
        f"Verification: {'passed' if passed else 'failed'}",
        f"ChangeSet status: {status}",
        f"Notes: {notes}",
    ]
    if status == "verified" and stage.stage_id in {
        "requirements-definition",
        "use-case-definition",
    }:
        finalized = _finalize_temporary_changeset(
            repo_root,
            change_set_id=args.change_set_id,
            run_id=run_id,
            include_design_use_cases=stage.stage_id == "use-case-definition",
        )
        if finalized:
            final_id, final_path = finalized
            lines.append(f"Finalized ChangeSet: {args.change_set_id} -> {final_id}")
            lines.append(f"Finalized path: {final_path}")
    return "\n".join(lines)


def _format_already_verified_procedure_stage(
    repo_root: Path,
    change_set_path: Path,
    stage: ProcedureStage,
    *,
    change_set_id: str,
    uc_id: str | None,
) -> str:
    target = repo_root / change_set_path
    if not target.exists():
        return ""
    rows = parse_procedure_stage_rows(target.read_text(encoding="utf-8"))
    row = next((item for item in rows if item.get("id") == stage.stage_id), None)
    if row is None or row.get("status") != "verified":
        return ""

    passed, _problems = verify_procedure_stage(
        repo_root,
        stage,
        change_set_id=change_set_id,
        uc_id=uc_id,
    )
    if not passed:
        return ""
    return "\n".join(
        [
            f"Stage: {stage.stage_id}",
            "Run: -",
            "Interactive status: complete",
            "Verification: passed",
            "ChangeSet status: verified",
            "Changed files: -",
            "Session: -",
            f"Notes: already verified at {row.get('verified_at') or '-'}; {row.get('notes') or '-'}",
        ]
    )


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
    include_design_use_cases: bool = False,
) -> tuple[str, Path] | None:
    if not change_set_id.startswith("CHG-TEMP-"):
        return None

    old_path = Path("docs/changes/active") / f"{change_set_id}.md"
    old_absolute = repo_root / old_path
    if not old_absolute.exists() or not _requirements_doc_exists(repo_root):
        return None

    old_text = old_absolute.read_text(encoding="utf-8")
    final_title = _final_changeset_title(repo_root, old_text, old_id=change_set_id)
    final_id = _suggest_next_change_set_id(repo_root)
    retargeted_old_text = _retarget_changeset_references(
        old_text,
        old_id=change_set_id,
        final_id=final_id,
    )
    if include_design_use_cases and _design_docs_exist(repo_root):
        result = create_changeset_from_design(
            repo_root,
            title=final_title,
            change_set_id=final_id,
            force=False,
        )
        final_path = result.change_set_path
        final_absolute = repo_root / final_path
        final_text = final_absolute.read_text(encoding="utf-8")
        final_absolute.write_text(
            _append_runtime_procedure_state(final_text, retargeted_old_text),
            encoding="utf-8",
        )
    else:
        final_path = Path("docs/changes/active") / f"{final_id}.md"
        final_absolute = repo_root / final_path
        final_absolute.write_text(
            _rewrite_temporary_changeset_text(
                retargeted_old_text,
                old_id=change_set_id,
                final_id=final_id,
                final_title=final_title,
            ),
            encoding="utf-8",
        )
    old_absolute.unlink()
    _retarget_design_doc_changeset_references(
        repo_root,
        old_id=change_set_id,
        final_id=final_id,
    )
    _retarget_run_state(repo_root, run_id=run_id, change_set_id=final_id)
    return final_id, final_path


def _requirements_doc_exists(repo_root: Path) -> bool:
    return (Path(repo_root) / "docs/design/요구사항.md").exists()


def _rewrite_temporary_changeset_text(
    text: str,
    *,
    old_id: str,
    final_id: str,
    final_title: str,
) -> str:
    updated = re.sub(
        r"(?m)^# .*$",
        lambda _match: f"# {final_title}",
        text,
        count=1,
    )
    updated = _retarget_changeset_references(updated, old_id=old_id, final_id=final_id)
    if final_title:
        updated = re.sub(
            r"(?m)^- Request summary: .*$",
            lambda _match: f"- Request summary: {final_title}",
            updated,
            count=1,
        )
    return updated


def _retarget_changeset_references(text: str, *, old_id: str, final_id: str) -> str:
    return text.replace(
        f"docs/changes/active/{old_id}.md",
        f"docs/changes/active/{final_id}.md",
    ).replace(old_id, final_id)


def _retarget_design_doc_changeset_references(
    repo_root: Path,
    *,
    old_id: str,
    final_id: str,
) -> None:
    for relative_path in (
        Path("docs/design/요구사항.md"),
        Path("docs/design/유스케이스.md"),
        Path("docs/design/ubiquitous-language.md"),
        Path("context.md"),
    ):
        path = repo_root / relative_path
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        updated = _retarget_changeset_references(text, old_id=old_id, final_id=final_id)
        if updated != text:
            path.write_text(updated, encoding="utf-8")


def _final_changeset_title(repo_root: Path, change_set_text: str, *, old_id: str) -> str:
    for candidate in (
        _title_from_design(repo_root),
        _title_from_changeset_text(change_set_text, old_id=old_id),
    ):
        title = _normalize_changeset_title(candidate, old_id=old_id)
        if title:
            return title
    return old_id


def _title_from_changeset_text(text: str, *, old_id: str) -> str:
    change_set = parse_changeset_markdown(text)
    for candidate in (change_set.title, change_set.intent_summary):
        title = _normalize_changeset_title(candidate, old_id=old_id)
        if title:
            return title
    return ""


def _title_from_design(repo_root: Path) -> str:
    preferred_labels = (
        "Initial idea",
        "Change title",
        "MVP use case",
        "Goal",
        "User-visible success condition",
        "Request summary",
    )
    fallback = ""
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
                label, value = stripped.split(":", maxsplit=1)
                if label.strip() in preferred_labels:
                    return value.strip().rstrip(".")
                fallback = fallback or value.strip().rstrip(".")
                continue
            fallback = fallback or stripped.rstrip(".")
    return fallback


def _normalize_changeset_title(value: str, *, old_id: str) -> str:
    title = (value or "").strip().strip("`").rstrip(".")
    if not title:
        return ""
    if title in {
        old_id,
        f"ChangeSet {old_id}",
        f"Temporary ChangeSet {old_id}",
        "temporary",
        "Temporary",
        "-",
    }:
        return ""
    if title.startswith("CHG-TEMP-"):
        return ""
    return title


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
        "answers": _initial_interactive_stage_answers_from_env(),
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
        result = _enforce_interactive_stage_question_policy(stage.stage_id, result)
        if stage.stage_id == "technical-decisions" and result["status"] == "blocked":
            pending_questions = _pending_technical_decision_questions(
                repo_root,
                uc_id,
            )
            if pending_questions:
                result = {
                    **result,
                    "status": "needs_input",
                    "questions": pending_questions,
                    "blocker": "technical decisions need user input",
                }
            else:
                result = _technical_decisions_blocker_as_user_input(
                    stage.stage_id,
                    result,
                )
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
            if _interactive_stage_noninteractive():
                session["status"] = "needs_input"
                session["pending_questions"] = result["questions"]
                session["blocker"] = "interactive Grill-Me stage needs user input"
                _save_interactive_stage_session(run_dir, session)
                break
            answers = _read_interactive_stage_answers(stage, result["questions"])
            session["answers"].extend(answers)
            _save_interactive_stage_session(run_dir, session)
            continue

        if result["status"] == "complete" and _interactive_stage_uses_content_review(stage.stage_id):
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
            review = _enforce_interactive_review_stage_boundary(stage.stage_id, review)
            review = _technical_decisions_blocker_as_user_input(
                stage.stage_id,
                review,
            )
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
                if _interactive_stage_noninteractive():
                    final_result = {
                        **result,
                        "status": "needs_input",
                        "questions": review["questions"],
                        "blocker": "content review needs user input",
                    }
                    session["status"] = "needs_input"
                    session["pending_questions"] = review["questions"]
                    session["blocker"] = "content review needs user input"
                    _save_interactive_stage_session(run_dir, session)
                    break
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

    if stage.stage_id == "technical-decisions" and final_result["status"] == "blocked":
        pending_questions = _pending_technical_decision_questions(repo_root, uc_id)
        if pending_questions:
            final_result = {
                **final_result,
                "status": "needs_input",
                "questions": pending_questions,
                "blocker": "technical decisions need user input",
            }
            session["status"] = "needs_input"
            session["pending_questions"] = pending_questions
            session["blocker"] = "technical decisions need user input"
            _save_interactive_stage_session(run_dir, session)

    if final_result["status"] == "blocked":
        status = "blocked"
        notes = final_result["blocker"] or "interactive Grill-Me stage blocked"
        verification = "skipped"
    elif final_result["status"] == "needs_input":
        status = "blocked"
        notes = final_result["blocker"] or "interactive Grill-Me stage needs user input"
        verification = "skipped"
    else:
        passed, problems = verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=args.change_set_id,
            uc_id=uc_id,
        )
        pending_questions = (
            _pending_technical_decision_questions(repo_root, uc_id)
            if stage.stage_id == "technical-decisions" and not passed
            else []
        )
        if pending_questions:
            final_result = {
                **final_result,
                "status": "needs_input",
                "questions": pending_questions,
                "blocker": "technical decisions need user input",
            }
            session["status"] = "needs_input"
            session["pending_questions"] = pending_questions
            session["blocker"] = "technical decisions need user input"
            _save_interactive_stage_session(run_dir, session)
            status = "blocked"
            notes = "technical decisions need user input"
            verification = "skipped"
        else:
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
    if final_result["status"] == "needs_input":
        lines.append("Pending questions:")
        for index, question in enumerate(final_result["questions"], start=1):
            lines.append(f"{index}. {question['question']}")
            if question["recommended"]:
                lines.append(f"   Recommended: {question['recommended']}")
    if status == "verified" and stage.stage_id in {
        "requirements-definition",
        "use-case-definition",
    }:
        finalized = _finalize_temporary_changeset(
            repo_root,
            change_set_id=args.change_set_id,
            run_id=run_id,
            include_design_use_cases=stage.stage_id == "use-case-definition",
        )
        if finalized:
            final_id, final_path = finalized
            lines.append(f"Finalized ChangeSet: {args.change_set_id} -> {final_id}")
            lines.append(f"Finalized path: {final_path}")
    return "\n".join(lines)


def _run_all_technical_decisions_stage(
    args: argparse.Namespace,
    repo_root: Path,
    mode: RunMode,
) -> str:
    change_set = _load_change_set(repo_root, args.change_set_id)
    uc_ids = _change_set_use_case_ids(repo_root, change_set)
    if not uc_ids:
        return f"BLOCKED: technical-decisions requires affected use cases for {change_set.change_set_id}"

    target_uc_ids = list(uc_ids)
    if mode == RunMode.PLAN:
        return "\n".join(
            [
                "Stage: technical-decisions",
                "Mode: run-all",
                f"ChangeSet: {change_set.change_set_id}",
                "Target use cases:",
                *(f"- {uc_id}" for uc_id in target_uc_ids),
            ]
        )

    outputs: list[str] = [
        "Stage: technical-decisions",
        "Mode: run-all",
        f"ChangeSet: {change_set.change_set_id}",
        "Target use cases:",
        *(f"- {uc_id}" for uc_id in target_uc_ids),
    ]
    blocked: list[str] = []
    for uc_id in target_uc_ids:
        stage_args = argparse.Namespace(
            procedure_stage_id="technical-decisions",
            change_set_id=change_set.change_set_id,
            uc=uc_id,
            title=getattr(args, "title", ""),
            idea=getattr(args, "idea", ""),
            force=True,
            plan=False,
            preview=False,
            apply=True,
        )
        output = procedure_stage_command(stage_args, repo_root)
        outputs.append("")
        outputs.append(output)
        if not _procedure_stage_output_allows_next(output):
            blocked.append(uc_id)
            outputs.append(f"Blocked at {uc_id}; continuing remaining technical-decisions use cases.")
    if blocked:
        outputs.append("")
        outputs.append("ChangeSet status: blocked")
        outputs.append("Blocked use cases:")
        outputs.extend(f"- {uc_id}" for uc_id in blocked)
    else:
        outputs.append("")
        outputs.append("ChangeSet status: verified")
        outputs.append("Notes: all affected use cases completed technical decisions")
    return "\n".join(outputs)


def _utf8_safe_text(value: object) -> str:
    return str(value).encode("utf-8", errors="replace").decode("utf-8")


def _json_dumps_utf8_safe(value: object) -> str:
    return _utf8_safe_text(json.dumps(value, ensure_ascii=False, indent=2))


def _interactive_stage_noninteractive() -> bool:
    return os.environ.get("HARNESS_NONINTERACTIVE", "").strip().lower() in {
        "1",
        "true",
        "yes",
    }


def _initial_interactive_stage_answers_from_env() -> list[dict[str, str]]:
    raw_value = os.environ.get("HARNESS_INTERACTIVE_STAGE_ANSWERS", "").strip()
    if not raw_value:
        return []
    try:
        raw_answers = json.loads(raw_value)
    except json.JSONDecodeError as exc:
        raise ValueError("HARNESS_INTERACTIVE_STAGE_ANSWERS must be JSON") from exc
    if not isinstance(raw_answers, list):
        raise ValueError("HARNESS_INTERACTIVE_STAGE_ANSWERS must be a JSON list")
    answers: list[dict[str, str]] = []
    for raw_answer in raw_answers:
        if not isinstance(raw_answer, dict):
            raise ValueError("HARNESS_INTERACTIVE_STAGE_ANSWERS entries must be objects")
        question = _utf8_safe_text(raw_answer.get("question", "")).strip()
        answer = _utf8_safe_text(raw_answer.get("answer", "")).strip()
        recommended = _utf8_safe_text(raw_answer.get("recommended", "")).strip()
        if not question or not answer:
            raise ValueError("HARNESS_INTERACTIVE_STAGE_ANSWERS entries require question and answer")
        answers.append(
            {
                "question": question,
                "recommended": recommended,
                "answer": answer,
                "source": _utf8_safe_text(raw_answer.get("source", "rerun_ui")).strip()
                or "rerun_ui",
            }
        )
    return answers


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

Non-interactive rule:
{_interactive_stage_question_policy_prompt(stage.stage_id)}

JSON examples:
{_interactive_stage_json_examples(stage.stage_id)}
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

Non-interactive rule:
{_interactive_stage_question_policy_prompt(stage.stage_id)}

JSON examples:
{_interactive_review_json_examples(stage.stage_id, review_relative)}
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
            "- Do not change requirements or docs/design/ubiquitous-language.md; report upstream blocker if those inputs are not ready."
        ),
        "event-storming": (
            "- Owns commands, events, policies, systems, external systems, and invariants for selected UC.\n"
            "- Do not ask DDD aggregate or technical strategy questions; defer those downstream."
        ),
        "ddd-architecture-definition": (
            "- Owns DDD model derivation for the selected UC: entities, value objects, behaviors, "
            "application services, aggregates, bounded contexts, and evidence mapping.\n"
            "- Ask only when missing or contradictory slice evidence prevents a DDD structural decision.\n"
            "- Do not ask the user to choose representation details already implied by UC, event-storming, "
            "or E2E evidence; derive the model and cite that evidence.\n"
            "- Do not ask implementation strategy questions such as storage schema, UI layout, adapter shape, "
            "retry/cache/transaction details, or serialization mechanics; defer implementation strategy "
            "to technical-decisions."
        ),
        "technical-decisions": (
            "- Owns implementation strategy after DDD design: framework/library choices, persistence technology, "
            "adapter technology, AOP/proxy use, cipher/crypto primitive selection, retry/cache/transaction mechanics, "
            "observability tooling, and runtime technology choices.\n"
            "- Do not ask product/business policy questions such as whether a draft must exist, how long user data "
            "is retained, when abandoned/unsaved data is deleted, what source metadata is required, or what user-visible "
            "behavior should happen. Those belong upstream in requirements/use-case definition.\n"
            "- Treat a business policy as missing only when approved requirements, use-case flow, event-storming, DDD "
            "evidence, or E2E goals explicitly require that behavior and leave its policy contradictory or undefined.\n"
            "- Do not invent abandoned-draft, orphan-asset, retention, deletion, expiry, cleanup, or other hypothetical "
            "lifecycle scenarios outside the approved slice. Their absence is not an upstream blocker. Exclude them "
            "from this slice or choose a technical mechanism that avoids creating the hypothetical state.\n"
            "- If an explicitly required business policy is genuinely missing and blocks every valid implementation, "
            "return `blocked` with the exact upstream evidence and stage instead of asking the user here.\n"
            "- Do not reopen requirements, use-case behavior, event-storming semantics, or DDD model boundaries."
        ),
    }
    return boundaries.get(stage_id, "- Follow stage skill boundary.")


def _exec_stage_grill_me_prompt(root: Path, step_dir: Path, prompt: str, label: str) -> str:
    step_dir.mkdir(parents=True, exist_ok=True)
    final_message_path = step_dir / "final-message.md"
    prompt_path = step_dir / "prompt.md"
    stdout_path = step_dir / "stdout.txt"
    stderr_path = step_dir / "stderr.txt"
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
    timeout = int(
        os.environ.get(
            "HARNESS_CODEX_EXEC_TIMEOUT_SECONDS",
            str(INTERACTIVE_CODEX_EXEC_TIMEOUT_SECONDS),
        )
    )
    try:
        with stdout_path.open("w", encoding="utf-8") as stdout_file, stderr_path.open(
            "w", encoding="utf-8"
        ) as stderr_file:
            completed = subprocess.run(
                command,
                cwd=root,
                input=prompt,
                text=True,
                stdout=stdout_file,
                stderr=stderr_file,
                timeout=timeout,
                check=False,
            )
    except subprocess.TimeoutExpired as exc:
        with stderr_path.open("a", encoding="utf-8") as stderr_file:
            stderr_file.write(
                f"\n{label} timed out after {timeout} seconds while running: {' '.join(command)}\n"
            )
        raise ValueError(f"{label} timed out after {timeout} seconds") from exc

    stdout = _utf8_safe_text(stdout_path.read_text(encoding="utf-8"))
    stderr = _utf8_safe_text(stderr_path.read_text(encoding="utf-8"))
    if completed.returncode != 0:
        error = stderr.strip() or stdout.strip()
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


def _interactive_stage_allows_questions(stage_id: str) -> bool:
    return True


def _interactive_stage_uses_content_review(stage_id: str) -> bool:
    return stage_id != "ubiquitous-language-definition"


def _interactive_stage_question_policy_prompt(stage_id: str) -> str:
    if stage_id == "technical-decisions":
        return (
            "- This stage may return `needs_input` only for implementation-blocking technical mechanism choices inside "
            "the technical-decisions boundary, such as framework/library choice, persistence technology, adapter "
            "technology, AOP/proxy use, cipher/crypto primitive, retry/cache/transaction mechanics, observability "
            "tooling, or runtime technology choice.\n"
            "- Forbidden questions: product/business policy, user-visible behavior, whether a draft/asset/source must "
            "exist, how long unsaved or abandoned user data is retained, expiry duration, cleanup timing, source "
            "metadata rules, actor goals, success/failure policy, or DDD model boundaries.\n"
            "- Missing-policy blockers require explicit evidence that the approved slice needs that behavior. Do not "
            "block on invented abandoned-draft, orphan-asset, retention, deletion, expiry, or cleanup scenarios that "
            "are absent from requirements, use-case flow, event-storming, DDD evidence, and E2E goals.\n"
            "- For hypothetical lifecycle states outside the approved slice, omit the scenario or choose a mechanism "
            "that does not create it. Do not add it to Pending Decisions or Planner Requirements.\n"
            "- If an explicitly required upstream product/business policy blocks every valid implementation, return "
            "`blocked`, quote the exact upstream evidence, and name the upstream stage.\n"
            "- Do not silently leave `Approval Status` as `pending`; ask focused questions until the document can "
            "be approved, unless upstream inputs are missing, contradictory, or outside the technical-decisions boundary."
        )
    if stage_id != "ubiquitous-language-definition":
        return "- This stage may return `needs_input` only when user answers are required inside the stage boundary."
    return (
        "- This stage may ask Grill-Me questions only to clarify ubiquitous language.\n"
        "- Allowed questions: canonical term, Korean label, English/code-facing label, alias, forbidden term, exact term meaning, or term meaning boundary.\n"
        "- Forbidden questions: adding or changing requirements, product behavior, note/source policy, actor goal, success condition, failure policy, hard scope, DDD, infrastructure, or implementation strategy.\n"
        "- If requirements are missing or contradictory, return `blocked` with the upstream blocker instead of asking the user.\n"
        "- After writing `docs/design/ubiquitous-language.md`, do not run extra verification tool calls; return the JSON result immediately."
    )


def _interactive_stage_json_examples(stage_id: str) -> str:
    if stage_id == "technical-decisions":
        return "\n".join(
            [
                '{"status":"needs_input","questions":[{"question":"Which cipher should encrypt stored image bytes at rest: AES-256-GCM or ChaCha20-Poly1305?","recommended":"Use AES-256-GCM because it is widely supported by the Java runtime and existing security tooling."}],"changed_files":["docs/use-cases/UC-001/technical-decisions.md"],"blocker":""}',
                '{"status":"complete","questions":[],"changed_files":["docs/use-cases/UC-001/technical-decisions.md"],"blocker":""}',
                '{"status":"blocked","questions":[],"changed_files":[],"blocker":"Use-case step 8 explicitly requires export delivery, but requirements and E2E goals contradict whether delivery is synchronous or asynchronous."}',
            ]
        )
    if stage_id == "ubiquitous-language-definition":
        return "\n".join(
            [
                '{"status":"needs_input","questions":[{"question":"Which canonical term should represent an approved saved link between notes?","recommended":"Use Note Relationship / NoteRelationship."}],"changed_files":["docs/design/ubiquitous-language.md"],"blocker":""}',
                '{"status":"complete","questions":[],"changed_files":["docs/design/ubiquitous-language.md"],"blocker":""}',
                '{"status":"blocked","questions":[],"changed_files":[],"blocker":"Requirements contradict the confirmed term meaning."}',
            ]
        )
    examples = []
    if _interactive_stage_allows_questions(stage_id):
        examples.append(
            '{"status":"needs_input","questions":[{"question":"What decision is needed?","recommended":"Recommended answer."}],"changed_files":["docs/design/요구사항.md"],"blocker":""}'
        )
    examples.extend(
        [
            '{"status":"complete","questions":[],"changed_files":["docs/design/요구사항.md"],"blocker":""}',
            '{"status":"blocked","questions":[],"changed_files":[],"blocker":"Concrete blocker."}',
        ]
    )
    return "\n".join(examples)


def _interactive_review_json_examples(stage_id: str, review_relative: Path) -> str:
    examples = [
        f'{{"status":"complete","questions":[],"review_file":"{review_relative}","findings":[],"blocker":""}}'
    ]
    if stage_id == "ubiquitous-language-definition":
        examples.append(
            f'{{"status":"needs_input","questions":[{{"question":"Which canonical term should represent an approved saved link between notes?","recommended":"Use Note Relationship / NoteRelationship."}}],"review_file":"{review_relative}","findings":["Saved link term is ambiguous."],"blocker":""}}'
        )
    elif _interactive_stage_allows_questions(stage_id):
        examples.append(
            f'{{"status":"needs_input","questions":[{{"question":"Which success condition is canonical?","recommended":"Use the user-visible outcome in docs/design/요구사항.md."}}],"review_file":"{review_relative}","findings":["Ambiguous success condition."],"blocker":""}}'
        )
    examples.append(
        f'{{"status":"blocked","questions":[],"review_file":"{review_relative}","findings":["Use case contradicts confirmed requirement."],"blocker":"Use case contradicts confirmed requirement."}}'
    )
    return "\n".join(examples)


def _enforce_interactive_stage_question_policy(stage_id: str, result: dict) -> dict:
    if result.get("status") != "needs_input":
        return result
    if stage_id == "technical-decisions":
        questions = [
            question
            for question in result.get("questions", [])
            if _is_allowed_technical_decision_question(question)
        ]
        if questions:
            return {**result, "questions": questions}
        return {
            **result,
            "status": "blocked",
            "questions": [],
            "blocker": result.get("blocker")
            or "technical-decisions returned only questions outside the technical decision boundary",
        }
    if stage_id != "ubiquitous-language-definition":
        return result
    questions = [
        question
        for question in result.get("questions", [])
        if _is_allowed_ubiquitous_language_question(question)
    ]
    if questions:
        return {**result, "questions": questions}
    return {
        **result,
        "status": "blocked",
        "questions": [],
        "blocker": result.get("blocker")
        or "ubiquitous-language-definition returned only questions outside ubiquitous-language clarification boundary",
    }


def _technical_decisions_blocker_as_user_input(
    stage_id: str,
    result: dict,
) -> dict:
    if stage_id != "technical-decisions" or result.get("status") != "blocked":
        return result
    blocker = _utf8_safe_text(result.get("blocker", "")).strip()
    if not blocker:
        findings = result.get("findings", [])
        if isinstance(findings, list):
            blocker = "; ".join(
                _utf8_safe_text(finding).strip()
                for finding in findings
                if _utf8_safe_text(finding).strip()
            )
    blocker = blocker or "Technical Decisions cannot continue with current inputs."
    normalized = blocker.lower()
    if "ddd" in normalized or "architecture" in normalized:
        recommended = (
            "Rerun and approve DDD Architecture Definition, then retry "
            "Technical Decisions."
        )
    elif "requirement" in normalized:
        recommended = (
            "Resolve the cited Requirements decision, approve that stage, then "
            "retry Technical Decisions."
        )
    elif "use case" in normalized or "use-case" in normalized:
        recommended = (
            "Resolve the cited Use Case decision, approve that stage, then retry "
            "Technical Decisions."
        )
    else:
        recommended = (
            "Resolve the blocker in its owning upstream stage, then retry "
            "Technical Decisions."
        )
    return {
        **result,
        "status": "needs_input",
        "questions": [
            {
                "question": (
                    f"Technical Decisions is blocked: {blocker} "
                    "How should this blocker be resolved?"
                ),
                "recommended": recommended,
            }
        ],
        "blocker": blocker,
    }


def _pending_technical_decision_questions(
    repo_root: Path,
    uc_id: str | None,
) -> list[dict[str, str]]:
    if not uc_id:
        return []
    path = repo_root / "docs/use-cases" / uc_id / "technical-decisions.md"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    lines = text.splitlines()
    start = next(
        (
            index
            for index, line in enumerate(lines)
            if re.match(r"^##\s+\d*\.?\s*Pending Decisions\b", line.strip())
        ),
        -1,
    )
    if start < 0:
        return []
    questions: list[dict[str, str]] = []
    for line in lines[start + 1 :]:
        stripped = line.strip()
        if stripped.startswith("## "):
            break
        if not stripped.startswith(("- ", "* ")):
            continue
        item = stripped[2:].strip()
        if not item or item.lower().rstrip(".") == "none":
            continue
        marker = "Exact question:"
        question = item.split(marker, maxsplit=1)[1].strip() if marker in item else item
        question = question.strip()
        if question and not question.endswith("?"):
            question = question.rstrip(".") + "?"
        candidate = {"question": question, "recommended": ""}
        if not _is_allowed_technical_decision_question(candidate):
            continue
        questions.append(
            {
                "question": question,
                "recommended": (
                    "Choose the smallest implementation mechanism that preserves the "
                    "approved DDD boundary and existing runtime stack."
                ),
            }
        )
        if len(questions) >= 3:
            break
    return questions


def _enforce_interactive_review_stage_boundary(stage_id: str, review: dict) -> dict:
    if review.get("status") != "needs_input":
        return review
    if stage_id == "technical-decisions":
        questions = [
            question
            for question in review.get("questions", [])
            if _is_allowed_technical_decision_question(question)
        ]
        if questions:
            return {**review, "questions": questions}
        question_findings = [
            f"Review requested question outside technical-decisions boundary: {question.get('question', '')}"
            for question in review.get("questions", [])
            if isinstance(question, dict) and question.get("question")
        ]
        return {
            **review,
            "status": "blocked",
            "questions": [],
            "findings": [*review.get("findings", []), *question_findings],
            "blocker": review.get("blocker")
            or "content review requested only questions outside technical-decisions boundary",
        }
    if stage_id != "ubiquitous-language-definition":
        return review

    questions = [
        question
        for question in review.get("questions", [])
        if _is_allowed_ubiquitous_language_question(question)
    ]
    if questions:
        return {**review, "questions": questions}
    question_findings = [
        f"Review requested question outside ubiquitous-language clarification boundary: {question.get('question', '')}"
        for question in review.get("questions", [])
        if isinstance(question, dict) and question.get("question")
    ]
    return {
        **review,
        "status": "blocked",
        "questions": [],
        "findings": [*review.get("findings", []), *question_findings],
        "blocker": review.get("blocker")
        or "content review requested only questions outside ubiquitous-language clarification boundary",
    }


def _is_allowed_technical_decision_question(question: dict[str, str]) -> bool:
    if not isinstance(question, dict):
        return False
    text = f"{question.get('question', '')} {question.get('recommended', '')}".casefold()
    if not text.strip():
        return False
    forbidden_terms = (
        "business policy",
        "product policy",
        "user-visible",
        "actor goal",
        "success condition",
        "failure policy",
        "source metadata",
        "source required",
        "missing image source",
        "image source",
        "draft expiry",
        "draft expiration",
        "expiry",
        "expire",
        "how long",
        "retention",
        "retain",
        "abandoned",
        "unsaved draft",
        "unsaved image",
        "accepted-but-unsaved",
        "cleanup policy",
        "cleaned up",
        "deleted immediately",
        "retain indefinitely",
        "manual cleanup",
        "should drafts exist",
        "should a draft",
    )
    if any(term in text for term in forbidden_terms):
        return False
    allowed_terms = (
        "framework",
        "library",
        "adapter",
        "aop",
        "proxy",
        "cipher",
        "crypto",
        "encrypt",
        "aes",
        "gcm",
        "chacha",
        "database",
        "postgres",
        "mysql",
        "h2",
        "jpa",
        "jdbc",
        "redis",
        "cache",
        "queue",
        "topic",
        "outbox",
        "inbox",
        "idempotency",
        "retry",
        "backoff",
        "timeout",
        "circuit breaker",
        "transaction",
        "isolation",
        "migration",
        "schema",
        "observability",
        "metrics",
        "tracing",
        "logging",
        "testcontainer",
        "contract test",
    )
    return any(term in text for term in allowed_terms)


def _is_allowed_ubiquitous_language_question(question: dict[str, str]) -> bool:
    if not isinstance(question, dict):
        return False
    text = f"{question.get('question', '')} {question.get('recommended', '')}".casefold()
    if not text.strip():
        return False
    forbidden_terms = (
        "actor",
        "goal",
        "success condition",
        "failure policy",
        "hard scope",
        "scope belongs",
        "belongs in the product",
        "product behavior",
        "business policy",
        "mvp policy",
        "source policy",
        "source rule",
        "external source",
        "identified source",
        "grounding material",
        "identified grounding",
        "remain tied",
        "ongoing source",
        "ongoing grounding",
        "cite",
        "citation",
        "aggregate",
        "domain event",
        "state transition",
        "infrastructure",
        "implementation",
    )
    if any(term in text for term in forbidden_terms):
        return False
    allowed_terms = (
        "canonical term",
        "canonical name",
        "canonical label",
        "korean label",
        "english label",
        "code-facing label",
        "label",
        "alias",
        "aliases",
        "forbidden term",
        "forbidden terms",
        "meaning",
        "definition",
        "meaning boundary",
        "term boundary",
        "which term",
        "which word",
        "what term",
        "what word",
        "called",
        "name",
        "represents",
    )
    return any(term in text for term in allowed_terms)


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
    outputs = stage_outputs_for_run(
        stage,
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
    selected_work_item = str(getattr(args, "uc", "") or "").strip()
    if selected_work_item:
        scopes = tuple(scope for scope in scopes if scope.display_id == selected_work_item)
        if not scopes:
            raise ValueError(f"implementation --uc must identify an affected work item: {selected_work_item}")

    if mode in (RunMode.PLAN, RunMode.PREVIEW):
        return _format_scopes(change_set, scopes, mode)

    # Completed plans are not a completion shortcut. They re-enter this same
    # workflow with work-item nodes marked SKIPPED so final delivery gates still run.

    preflight_run_id = f"run-{uuid4().hex[:12]}"
    preflight = run_workflow_preflight(repo_root, change_set.change_set_id, scopes)
    preflight_path = write_preflight_result(repo_root, preflight_run_id, preflight)
    if not preflight.passed:
        return _format_preflight_blocked(
            change_set.change_set_id,
            preflight_run_id,
            preflight_path,
            preflight,
        )

    state, result = _apply_workflow(
        repo_root,
        change_set,
        scopes,
        run_id=preflight_run_id,
        force_verification=bool(getattr(args, "force_verification", False)),
        rollback_mode=str(getattr(args, "rollback", "none") or "none"),
    )
    execution = _implementation_execution_summary(result)
    active_changeset_moved = (
        not (repo_root / "docs/changes/active" / f"{change_set.change_set_id}.md").exists()
        and (repo_root / "docs/changes/completed" / f"{change_set.change_set_id}.md").exists()
    )
    return (
        f"APPLY started: run_id={state.run_id} status={result.status.value} "
        f"active_changeset_moved={str(active_changeset_moved).lower()}{execution}"
    )


def _implementation_execution_summary(result: RunResult) -> str:
    for step_result in reversed(result.step_results):
        mode = step_result.metadata.get("execution_mode")
        if mode:
            attempt = step_result.metadata.get("attempt", 1)
            return f" execution_mode={mode} attempt={attempt}"
    return ""


def _format_preflight_blocked(
    change_set_id: str,
    run_id: str,
    preflight_path: Path,
    preflight,
) -> str:
    blocking = preflight.blocking_checks
    first = blocking[0]
    evidence = "; ".join(first.evidence) if first.evidence else "no evidence recorded"
    remediation = first.remediation.replace("<CHG-ID>", change_set_id)
    relative_path = preflight_path.relative_to(preflight_path.parents[3])
    return "\n".join(
        [
            f"BLOCKED: deterministic preflight failed for {change_set_id}",
            f"Run ID: {run_id}",
            f"Preflight artifact: {relative_path}",
            f"Failed check: {first.check_id}",
            f"Evidence: {evidence}",
            f"Remediation: {remediation}",
            f"Resume command: harness implementation {change_set_id} --apply",
        ]
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


def memory_list_command(args: argparse.Namespace, repo_root: Path) -> str:
    entries = [
        entry
        for entry in load_memory_entries(repo_root)
        if args.all or entry.status == "active"
    ]
    if not entries:
        return "No memory entries found"
    return "\n".join(
        f"{entry.id}\t{entry.type}\t{entry.status}\t.harness/memory/{entry.path}"
        for entry in entries
    )


def memory_search_command(args: argparse.Namespace, repo_root: Path) -> str:
    results = search_memory(repo_root, args.query, include_inactive=args.all)
    if not results:
        return "No matching memory entries found"
    return "\n".join(
        "\t".join(
            [
                result.entry.id,
                result.entry.type,
                result.entry.status,
                f"score={result.score}",
                f"matched={','.join(result.matched_terms)}",
                f".harness/memory/{result.entry.path}",
            ]
        )
        for result in results
    )


def memory_score_command(args: argparse.Namespace, repo_root: Path) -> str:
    path = Path(args.candidate_path)
    absolute_path = path if path.is_absolute() else repo_root / path
    candidate = yaml.safe_load(absolute_path.read_text(encoding="utf-8")) or {}
    if not isinstance(candidate, dict):
        raise MemoryError("memory candidate score input must be a mapping")
    score = score_memory_candidate(candidate)
    missing = ",".join(score.required_fields_missing) or "none"
    return "\n".join(
        [
            f"score={score.total}",
            f"decision={score.decision}",
            f"missing_required_fields={missing}",
            f"active_ready={str(score.active_ready).lower()}",
        ]
    )


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
        help="Run workflow immediately. Default when no mode is supplied.",
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


def _work_item_plan_completed(repo_root: Path, scope) -> bool:
    return (
        (repo_root / _completed_plan_path(scope.display_id)).exists()
        and not (repo_root / _active_plan_path(scope)).exists()
    )


def _all_work_item_plans_completed(repo_root: Path, scopes: tuple) -> bool:
    return bool(scopes) and all(
        _work_item_plan_completed(repo_root, scope) for scope in scopes
    )




def _active_plan_path(scope) -> Path:
    return scope.plan_path or Path(f"docs/plans/active/{scope.display_id}/plan.md")


def _completed_plan_path(work_item_id: str) -> Path:
    return Path(f"docs/plans/completed/{work_item_id}/plan.md")


def _apply_workflow(
    repo_root: Path,
    change_set: ChangeSet,
    scopes: tuple,
    *,
    run_id: str | None = None,
    force_verification: bool = False,
    rollback_mode: str = "none",
):
    run_id = run_id or f"run-{uuid4().hex[:12]}"
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
    use_case_count = sum(scope.use_case is not None for scope in scopes)
    use_case_index = 0
    for scope_index, scope in enumerate(scopes):
        if scope.use_case is not None:
            use_case_index += 1
            print(
                f"Use case execution start: "
                f"{_use_case_execution_label(scope.use_case.uc_id, scope.use_case.name)} "
                f"({use_case_index}/{use_case_count})",
                flush=True,
            )
        materialized_workflow = materialize_workflow_for_scope(
            workflow, change_set, scope, run_id=run_id
        )
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
                "force_verification": force_verification,
                "rollback_mode": rollback_mode,
                "is_final_work_item": scope_index == len(scopes) - 1,
                "skip_precompleted_work_item_steps": _work_item_plan_completed(
                    repo_root,
                    scope,
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
        if scope.use_case is not None:
            print(
                _format_use_case_execution_result(
                    scope.use_case.uc_id,
                    scope.use_case.name,
                    scope_result,
                ),
                flush=True,
            )
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


def _format_use_case_execution_result(
    uc_id: str,
    use_case_name: str,
    result: RunResult,
) -> str:
    details = [
        f"Use case execution result: {_use_case_execution_label(uc_id, use_case_name)}",
        f"status={result.status.value}",
    ]
    if result.failed_step_id:
        details.append(f"failed_step={result.failed_step_id}")
    if result.failure_kind:
        details.append(f"failure_kind={result.failure_kind.value}")
    if result.blocker:
        details.append(f"blocker={' '.join(result.blocker.split())}")
    return " ".join(details)


def _use_case_execution_label(uc_id: str, use_case_name: str) -> str:
    normalized_name = " ".join(use_case_name.split())
    return f"{uc_id} - {normalized_name}" if normalized_name else uc_id


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
    if failure_kind == FailureKind.PLAN_REVIEW_REJECTED:
        return RunFailureKind.PLAN_REVIEW_REJECTED
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
