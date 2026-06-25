"""README-aligned public harness CLI."""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from harness_codex import cli as _stage_runtime
from harness_codex.memory_cli import main as memory_main
from harness_codex.runtime.changes import ChangeSetResolver, NoActiveChangeSetsError


_REMOVED_TOP_LEVEL_COMMANDS = frozenset({"ultrawork", "change-set-pr"})
_EXTRA_PUBLIC_STAGE_COMMANDS = (
    (
        "ddd-design-integration",
        "Integrate candidate DDD designs into a ChangeSet-level canonical contract.",
    ),
)


@dataclass(frozen=True)
class PublicCommand:
    name: str
    summary: str
    group: str
    topic_help: str


_COMMAND_GROUPS: dict[str, str] = {
    "help": "Start and continue",
    "init": "Setup and maintenance",
    "agent-context": "Setup and maintenance",
    "requirements-definition": "Start and continue",
    "ubiquitous-language-definition": "Workflow stages",
    "use-case-definition": "Workflow stages",
    "event-storming": "Workflow stages",
    "ddd-architecture-definition": "Workflow stages",
    "ddd-design-integration": "Workflow stages",
    "technical-decisions": "Workflow stages",
    "plan-writing": "Workflow stages",
    "implementation": "Workflow stages",
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
    "help": (
        "Usage: harness help [COMMAND [SUBCOMMAND]]\n\n"
        "Show workflow-aware guidance without running agents, mutating files, or "
        "creating RunState. With no topic, help reads active ChangeSet metadata "
        "and suggests the next safe command."
    ),
    "requirements-definition": (
        "Usage: harness requirements-definition [CHG-ID] --title TEXT --idea TEXT [--force]\n\n"
        "Start a ChangeSet from a product or engineering request. Omit CHG-ID to "
        "create or finalize the current ChangeSet; provide one to update that ChangeSet explicitly."
    ),
    "ddd-design-integration": (
        "Usage: harness ddd-design-integration CHG-ID --plan|--preview|--apply\n\n"
        "Read every affected use-case candidate DDD design, reconcile compatible "
        "models into one canonical ChangeSet contract, and fail closed when a domain "
        "policy or Aggregate boundary conflict is not supported by upstream evidence. "
        "This stage does not accept --uc."
    ),
    "changes": (
        "Usage: harness changes list|active\n"
        "       harness changes show|delete|contents|continue CHG-ID [OPTIONS]\n"
        "       harness changes document-delta CHG-ID --uc UC-ID --summary TEXT [OPTIONS]\n\n"
        "Inspect and resume ChangeSets."
    ),
    "implementation": (
        "Usage: harness implementation CHG-ID [--force-verification] "
        "[--rollback none|safe|git] --plan|--preview|--apply\n\n"
        "Run every incomplete work item in one ChangeSet through planning, implementation, verification, and delivery gates."
    ),
    "memory": (
        "Usage: harness memory list [--kind KIND]\n"
        "       harness memory search QUERY [--kind KIND] [--change-set ID] [--work-item ID] [--stage STAGE] [--limit N]\n"
        "       harness memory reindex\n\n"
        "Search reviewed ChangeSet-first memory under docs/memory."
    ),
}


_NESTED_TOPIC_HELP: dict[tuple[str, str], str] = {
    ("changes", "continue"): (
        "Usage: harness changes continue CHG-ID [--uc UC-ID] "
        "[--blocker-resolution requirements|use-case] [--resolution-prompt TEXT] "
        "[--force-verification] --plan|--preview|--apply\n\n"
        "Resume the first incomplete or blocked stage of an active ChangeSet."
    ),
    ("changes", "active"): "Usage: harness changes active\n\nShow active ChangeSets and runtime readiness.",
    ("changes", "show"): "Usage: harness changes show CHG-ID\n\nShow ChangeSet intent and affected work items.",
    ("changes", "contents"): "Usage: harness changes contents CHG-ID [--raw]\n\nShow ChangeSet content.",
    ("contracts", "validate"): "Usage: harness contracts validate CHG-ID [--work-item ID] [--json]\n\nValidate document handoff contracts.",
    ("run", "app"): "Usage: harness run app [--timeout SECONDS] [-- SERVER_ARG ...]\n\nRun repository-local application sessions.",
    ("run", "wiki"): "Usage: harness run wiki [serve|build|install] [--dev-addr HOST:PORT]\n\nRun the repository wiki command.",
    ("completion", "install"): "Usage: harness completion install [--shell auto|zsh|bash|all]\n\nInstall bundled shell completion.",
}


def _stage_command_help() -> tuple[tuple[str, str], ...]:
    commands = list(_stage_runtime.COMMAND_HELP)
    known = {name for name, _summary in commands}
    commands.extend(command for command in _EXTRA_PUBLIC_STAGE_COMMANDS if command[0] not in known)
    return tuple(commands)


def _build_command_catalog() -> tuple[PublicCommand, ...]:
    entries: list[PublicCommand] = []
    for command, summary in _stage_command_help():
        if command in _REMOVED_TOP_LEVEL_COMMANDS:
            continue
        public_summary = "List, search, or reindex reviewed ChangeSet-first memory." if command == "memory" else summary
        topic_help = _TOPIC_HELP_OVERRIDES.get(command) or _stage_runtime.TOPIC_HELP.get(
            command,
            f"Usage: harness {command}",
        )
        entries.append(PublicCommand(command, public_summary, _COMMAND_GROUPS.get(command, "Operations and advanced"), topic_help))
    return tuple(entries)


COMMAND_CATALOG = _build_command_catalog()
COMMAND_HELP: tuple[tuple[str, str], ...] = tuple((entry.name, entry.summary) for entry in COMMAND_CATALOG)
PUBLIC_COMMANDS = frozenset(entry.name for entry in COMMAND_CATALOG)
TOPIC_HELP = {entry.name: entry.topic_help for entry in COMMAND_CATALOG}


def main(argv: list[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    command, positional = _public_command(arguments)
    repo_root = _repo_root_from_arguments(arguments)
    if command is None or command in {"-h", "--help"}:
        print(help_command(None, repo_root=repo_root))
        return 0
    if command == "help":
        try:
            print(help_command(tuple(positional[1:]) or None, repo_root=repo_root))
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        return 0
    if command == "memory":
        return memory_main(_memory_arguments(arguments))
    if command not in PUBLIC_COMMANDS:
        print(f"unknown public harness command: {command}. Use `harness help` to view supported commands.", file=sys.stderr)
        return 2
    return _stage_runtime.main(arguments)


def build_parser() -> argparse.ArgumentParser:
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


def help_command(topic: str | Sequence[str] | None, *, repo_root: Path | str = ".") -> str:
    topic_parts = _normalize_topic(topic)
    if not topic_parts:
        return "\n".join(("Harness runtime guide", "", _format_guided_actions(Path(repo_root)), "", _format_command_list()))
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
    lines = ["Next action:"]
    try:
        active_change_sets = tuple(ChangeSetResolver(repo_root).list_active())
    except NoActiveChangeSetsError:
        active_change_sets = ()
    except Exception as exc:
        return "\n".join(("Next action:", "  Workspace state could not be read.", "  Inspect: harness changes list", f"  Detail: {exc}"))
    if not active_change_sets:
        return "\n".join((*lines, "  Start a ChangeSet:", "  harness requirements-definition --title \"Change title\" --idea \"Product or engineering request\""))
    if len(active_change_sets) == 1:
        change_set = active_change_sets[0]
        title = change_set.title or change_set.intent_summary or "-"
        status = change_set.status or "active"
        return "\n".join((*lines, f"  Continue {change_set.change_set_id} [{status}]: {title}", "  Inspect: harness changes active", f"  Safe plan: harness changes continue {change_set.change_set_id} --plan", f"  Apply:     harness changes continue {change_set.change_set_id} --apply"))
    lines.append("  Multiple active ChangeSets:")
    lines.extend(f"  - {change_set.change_set_id}: {change_set.title or change_set.intent_summary or '-'}" for change_set in active_change_sets)
    lines.extend(("  Choose one: harness changes show CHG-ID", "  Then plan: harness changes continue CHG-ID --plan"))
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
    return positional[0] if positional else None, positional


def _memory_arguments(arguments: list[str]) -> list[str]:
    command, _ = _public_command(arguments)
    if command != "memory":
        raise ValueError("memory arguments require the public memory command")
    marker = arguments.index("memory")
    return [*arguments[:marker], *arguments[marker + 1 :]]


def _format_command_list() -> str:
    lines: list[str] = ["Commands:"]
    groups = ("Start and continue", "Workflow stages", "Inspect and resume", "Operations and advanced", "Setup and maintenance")
    width = max(len(entry.name) for entry in COMMAND_CATALOG)
    for group in groups:
        entries = tuple(entry for entry in COMMAND_CATALOG if entry.group == group)
        if entries:
            lines.append(f"  {group}:")
            lines.extend(f"    {entry.name.ljust(width)}  {entry.summary}" for entry in entries)
    lines.extend(("", "README.md defines the supported staged workflow.", "Use `harness help <command> [subcommand]` for command usage."))
    return "\n".join(lines)
