"""README-aligned public harness CLI."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from harness_codex import cli as _stage_runtime
from harness_codex.memory_cli import main as memory_main
from harness_codex.runtime.changes import ChangeSetResolver, NoActiveChangeSetsError
from harness_codex.runtime.orchestrator_invocation import invoke_orchestrator
from harness_codex.orchestration.session import find_active_session_id


_REMOVED_TOP_LEVEL_COMMANDS = frozenset({"ultrawork", "change-set-pr"})
_LEGACY_STAGE_COMMANDS = frozenset({
    "requirements-definition",
    "ubiquitous-language-definition",
    "use-case-definition",
    "event-storming",
    "ddd-architecture-definition",
    "ddd-design-integration",
    "technical-decisions",
    "plan-writing",
})
_DDD_INTEGRATION_COMMAND = (
    "ddd-design-integration",
    "Integrate candidate DDD designs into a ChangeSet-level canonical contract.",
)
_DDD_INTEGRATION_HELP = (
    "Usage: harness ddd-design-integration CHG-ID --plan|--preview|--apply\n\n"
    "Read every affected use-case candidate DDD design, reconcile compatible "
    "models into one canonical ChangeSet contract, and fail closed when a domain "
    "policy or Aggregate boundary conflict is not supported by upstream evidence. "
    "This stage does not accept --uc."
)

if not any(name == _DDD_INTEGRATION_COMMAND[0] for name, _summary in _stage_runtime.COMMAND_HELP):
    _stage_runtime.COMMAND_HELP = (*_stage_runtime.COMMAND_HELP, _DDD_INTEGRATION_COMMAND)
    _stage_runtime.TOPIC_HELP = {
        **_stage_runtime.TOPIC_HELP,
        _DDD_INTEGRATION_COMMAND[0]: _DDD_INTEGRATION_HELP,
    }


@dataclass(frozen=True)
class PublicCommand:
    """One user-facing command entry shared by help and completion."""

    name: str
    summary: str
    group: str
    topic_help: str


_COMMAND_GROUPS: dict[str, str] = {
    "help": "Start and continue",
    "init": "Setup and maintenance",
    "agent-context": "Setup and maintenance",
    "requirements-definition": "Start and continue",
    "orchestrate": "Start and continue",
    "ubiquitous-language-definition": "Workflow stages",
    "use-case-definition": "Workflow stages",
    "event-storming": "Workflow stages",
    "ddd-architecture-definition": "Workflow stages",
    "ddd-design-integration": "Workflow stages",
    "technical-decisions": "Workflow stages",
    "plan-writing": "Workflow stages",
    "changes": "Inspect and resume",
    "contracts": "Inspect and resume",
    "stages": "Inspect and resume",
    "artifacts": "Inspect and resume",
    "resume": "Inspect and resume",
    "report": "Inspect and resume",
    "dashboard": "Inspect and resume",
    "run": "Operations and advanced",
    "completion": "Operations and advanced",
    "ui-server": "Operations and advanced",
    "memory": "Operations and advanced",
    "evolution": "Operations and advanced",
    "update": "Setup and maintenance",
    "reset": "Setup and maintenance",
}

_TOPIC_HELP_OVERRIDES: dict[str, str] = {
    "orchestrate": (
        "Usage: harness orchestrate TEXT\n\n"
        "사용자 요청을 설정된 workflow orchestration agent에 전달한다."
    ),
    "help": (
        "Usage: harness help [COMMAND [SUBCOMMAND]]\n\n"
        "Show workflow-aware guidance without running agents, mutating files, or "
        "creating RunState. With no topic, help reads active ChangeSet metadata "
        "and suggests the next safe command."
    ),
    "requirements-definition": (
        "Usage: harness requirements-definition [CHG-ID] --title TEXT --idea TEXT [--force]\n\n"
        "Start a ChangeSet from a product or engineering request. Omit CHG-ID to "
        "create or finalize the current ChangeSet; provide one to update that "
        "ChangeSet explicitly.\n\n"
        "Writes: docs/design/요구사항.md and ChangeSet procedure-stage state.\n"
        "Example:\n"
        "  harness requirements-definition --title \"Add guided help\" "
        "--idea \"Show the next safe runtime action\""
    ),
    "ddd-design-integration": _DDD_INTEGRATION_HELP,
    "changes": (
        "Usage: harness changes list|active\n"
        "       harness changes show|delete|contents CHG-ID [OPTIONS]\n"
        "       harness changes document-delta CHG-ID --uc UC-ID --summary TEXT [OPTIONS]\n\n"
        "Inspect ChangeSets. Workflow progression is owned by the configured orchestration agent."
    ),
    "memory": (
        "Usage: harness memory list [--kind KIND]\n"
        "       harness memory search QUERY [--kind KIND] [--change-set ID] "
        "[--work-item ID] [--stage STAGE] [--limit N]\n"
        "       harness memory reindex\n"
        "       harness memory cache read|warm|stats|clear [OPTIONS]\n"
        "       harness memory graph status|build|rebuild|query [OPTIONS]\n\n"
        "Search reviewed ChangeSet-first memory under docs/memory and manage "
        "run-local file read cache snapshots. Build/query external Graphify "
        "context for design docs and source code. Legacy score-based "
        ".harness/memory commands are retired."
    ),
}

_NESTED_TOPIC_HELP: dict[tuple[str, str], str] = {
    ("changes", "active"): (
        "Usage: harness changes active\n\n"
        "Show each active ChangeSet with runtime readiness, work-item state, "
        "plan path, verification goal, and latest run details. Read-only."
    ),
    ("changes", "show"): (
        "Usage: harness changes show CHG-ID\n\n"
        "Show the ChangeSet's intent, before/after summary, and affected work "
        "items. Read-only."
    ),
    ("changes", "contents"): (
        "Usage: harness changes contents CHG-ID [--raw]\n\n"
        "Show structured ChangeSet content; use --raw to print its markdown "
        "source. Read-only."
    ),
    ("contracts", "validate"): (
        "Usage: harness contracts validate CHG-ID [--work-item ID] [--json]\n\n"
        "Validate document handoff contracts before implementation or after an "
        "upstream document change. Read-only."
    ),
    ("run", "app"): (
        "Usage: harness run app [dev|prod] [start|stop|health|deploy|env|status] [-- APP_ARG ...]\n"
        "       harness run app [--timeout SECONDS] [-- SERVER_ARG ...]\n"
        "       harness run app --foreground [-- APP_ARG ...]\n"
        "       harness run app status|stop|attach infra|server\n\n"
        "Start, inspect, attach to, or stop repository-local application sessions."
    ),
    ("run", "wiki"): (
        "Usage: harness run wiki [serve|build|install] [--dev-addr HOST:PORT]\n\n"
        "Run the repository MkDocs wiki command."
    ),
    ("completion", "install"): (
        "Usage: harness completion install [--shell auto|zsh|bash|all]\n\n"
        "Install bundled completion for the current shell."
    ),
}


def _build_command_catalog() -> tuple[PublicCommand, ...]:
    entries: list[PublicCommand] = []
    for command, summary in _stage_runtime.COMMAND_HELP:
        if command in _REMOVED_TOP_LEVEL_COMMANDS or command in _LEGACY_STAGE_COMMANDS:
            continue
        public_summary = (
            "List, search, or reindex reviewed ChangeSet-first memory."
            if command == "memory"
            else summary
        )
        entries.append(
            PublicCommand(
                name=command,
                summary=public_summary,
                group=_COMMAND_GROUPS.get(command, "Operations and advanced"),
                topic_help=_TOPIC_HELP_OVERRIDES.get(
                    command,
                    _stage_runtime.TOPIC_HELP[command],
                ),
            )
        )
    entries.append(
        PublicCommand(
            name="orchestrate",
            summary="사용자 요청을 workflow orchestration agent에 전달한다.",
            group=_COMMAND_GROUPS["orchestrate"],
            topic_help=_TOPIC_HELP_OVERRIDES["orchestrate"],
        )
    )
    return tuple(entries)


COMMAND_CATALOG = _build_command_catalog()
COMMAND_HELP: tuple[tuple[str, str], ...] = tuple(
    (entry.name, entry.summary) for entry in COMMAND_CATALOG
)
PUBLIC_COMMANDS = frozenset(entry.name for entry in COMMAND_CATALOG)
TOPIC_HELP = {entry.name: entry.topic_help for entry in COMMAND_CATALOG}


def main(argv: list[str] | None = None) -> int:
    """Run the public workflow without mutating argparse internals."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    command, positional = _public_command(arguments)
    repo_root = _repo_root_from_arguments(arguments)

    if command is None or command in {"-h", "--help"}:
        print(help_command(None, repo_root=repo_root))
        return 0
    if command == "help":
        topic: tuple[str, ...] = tuple(positional[1:])
        try:
            print(help_command(topic or None, repo_root=repo_root))
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        return 0
    if command == "memory":
        return memory_main(_memory_arguments(arguments))
    if command == "orchestrate":
        prompt = " ".join(positional[1:]).strip()
        if not prompt:
            print("orchestrate requires a user prompt", file=sys.stderr)
            return 2
        result = invoke_orchestrator(
            prompt,
            repo_root=repo_root,
            session_id=find_active_session_id(repo_root, prompt),
        )
        if result.output:
            print(result.output)
        if result.error:
            print(result.error, file=sys.stderr)
        return 0 if result.status == "completed" else 1
    if command == "resume":
        if len(positional) < 2:
            print("resume requires RUN-ID", file=sys.stderr)
            return 2
        run_id = positional[1]
        request_path = repo_root / ".harness" / "orchestration" / run_id / "request.json"
        try:
            original_prompt = str(json.loads(request_path.read_text(encoding="utf-8"))["instruction"])
        except (OSError, ValueError, KeyError, TypeError):
            print(f"resume request not found: {request_path}", file=sys.stderr)
            return 2
        result = invoke_orchestrator(
            original_prompt,
            repo_root=repo_root,
            session_id=run_id,
            resume=True,
        )
        if result.output:
            print(result.output)
        if result.error:
            print(result.error, file=sys.stderr)
        return 0 if result.status == "completed" else 1
    if command in _LEGACY_STAGE_COMMANDS:
        print(
            f"legacy direct stage command removed: {command}. Use `harness orchestrate TEXT` or `harness resume RUN-ID`.",
            file=sys.stderr,
        )
        return 2
    if command not in PUBLIC_COMMANDS:
        print(
            f"unknown public harness command: {command}. "
            "Use `harness help` to view supported commands.",
            file=sys.stderr,
        )
        return 2

    return _stage_runtime.main(arguments)


def build_parser() -> argparse.ArgumentParser:
    """Build the public command catalog without changing the internal parser."""

    parser = argparse.ArgumentParser(
        prog="harness",
        description="Harness runtime for the staged workflow in README.md.",
        epilog=_format_command_list(),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--repo-root", default=".")
    subparsers = parser.add_subparsers(dest="command")
    for command, summary in COMMAND_HELP:
        command_parser = subparsers.add_parser(command, help=summary)
        command_parser.add_argument("command_args", nargs=argparse.REMAINDER)
    return parser


def help_command(
    topic: str | Sequence[str] | None,
    *,
    repo_root: Path | str = ".",
) -> str:
    """Render read-only overview or topic help for the public command catalog."""

    topic_parts = _normalize_topic(topic)
    if not topic_parts:
        return "\n".join(
            (
                "Harness runtime guide",
                "",
                _format_guided_actions(Path(repo_root)),
                "",
                _format_command_list(),
            )
        )
    if len(topic_parts) == 1 and topic_parts[0] in TOPIC_HELP:
        return TOPIC_HELP[topic_parts[0]]
    nested_help = _NESTED_TOPIC_HELP.get(topic_parts)
    if nested_help:
        return nested_help
    raise ValueError(f"unknown public harness help topic: {' '.join(topic_parts)}")


def _normalize_topic(topic: str | Sequence[str] | None) -> tuple[str, ...]:
    if topic is None:
        return ()
    if isinstance(topic, str):
        return tuple(part for part in topic.split() if part)
    return tuple(str(part).strip() for part in topic if str(part).strip())


def _format_guided_actions(repo_root: Path) -> str:
    """Return repository-aware next steps without invoking runtime execution."""

    lines = ["Next action:"]
    try:
        active_change_sets = tuple(ChangeSetResolver(repo_root).list_active())
    except NoActiveChangeSetsError:
        active_change_sets = ()
    except Exception as exc:  # Help must remain available for a damaged workspace.
        lines.extend(
            (
                "  Workspace state could not be read.",
                "  Inspect: harness changes list",
                f"  Detail: {exc}",
            )
        )
        return "\n".join(lines)

    if not active_change_sets:
        lines.extend(
            (
                "  Start a ChangeSet:",
                "  harness requirements-definition --title \"Change title\" "
                "--idea \"Product or engineering request\"",
            )
        )
        return "\n".join(lines)

    if len(active_change_sets) == 1:
        change_set = active_change_sets[0]
        title = change_set.title or change_set.intent_summary or "-"
        status = change_set.status or "active"
        lines.extend(
            (
                f"  Continue {change_set.change_set_id} [{status}]: {title}",
                "  Inspect: harness changes active",
                "  Implementation: orchestration agent receives the request and delegates specialist work",
            )
        )
        return "\n".join(lines)

    lines.append("  Multiple active ChangeSets:")
    for change_set in active_change_sets:
        title = change_set.title or change_set.intent_summary or "-"
        lines.append(f"  - {change_set.change_set_id}: {title}")
    lines.extend(
        (
            "  Choose one: harness changes show CHG-ID",
            "  Then use `harness orchestrate \"request\"` for workflow execution.",
        )
    )
    return "\n".join(lines)


def _repo_root_from_arguments(arguments: Iterable[str]) -> Path:
    arguments_list = list(arguments)
    for index, argument in enumerate(arguments_list):
        if argument == "--repo-root" and index + 1 < len(arguments_list):
            return Path(arguments_list[index + 1])
        if argument.startswith("--repo-root="):
            return Path(argument.partition("=")[2])
    return Path(".")


def _public_command(arguments: Iterable[str]) -> tuple[str | None, list[str]]:
    """Return the first command while ignoring the global repo-root option."""

    positional: list[str] = []
    skip_next = False
    for argument in arguments:
        if skip_next:
            skip_next = False
            continue
        if argument == "--repo-root":
            skip_next = True
            continue
        if argument.startswith("--repo-root="):
            continue
        if argument in {"-h", "--help"} and not positional:
            return argument, positional
        if argument.startswith("-"):
            continue
        positional.append(argument)
    return (positional[0] if positional else None), positional


def _memory_arguments(arguments: list[str]) -> list[str]:
    """Remove the public memory token while preserving global CLI options."""

    command, _ = _public_command(arguments)
    if command != "memory":
        raise ValueError("memory arguments require the public memory command")
    marker = arguments.index("memory")
    return [*arguments[:marker], *arguments[marker + 1 :]]


def _subcommand_arguments(arguments: list[str], command_name: str) -> list[str]:
    """Remove a public command token while preserving global CLI options."""

    command, _ = _public_command(arguments)
    if command != command_name:
        raise ValueError(f"{command_name} arguments require the public {command_name} command")
    marker = arguments.index(command_name)
    return [*arguments[:marker], *arguments[marker + 1 :]]


def _format_command_list() -> str:
    lines: list[str] = ["Commands:"]
    groups = (
        "Start and continue",
        "Workflow stages",
        "Inspect and resume",
        "Operations and advanced",
        "Setup and maintenance",
    )
    width = max(len(entry.name) for entry in COMMAND_CATALOG)
    for group in groups:
        entries = tuple(entry for entry in COMMAND_CATALOG if entry.group == group)
        if not entries:
            continue
        lines.append(f"  {group}:")
        lines.extend(
            f"    {entry.name.ljust(width)}  {entry.summary}" for entry in entries
        )
    lines.extend(
        (
            "",
            "README.md defines the supported staged workflow.",
            "Use `harness help <command> [subcommand]` for command usage.",
        )
    )
    return "\n".join(lines)
