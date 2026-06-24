"""README-aligned public harness CLI.

The public launcher owns the supported command boundary.  The legacy stage runtime
continues to implement the stage handlers, but commands that are intentionally not
part of the README workflow are rejected before they reach its parser.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable

from harness_codex import cli as _stage_runtime
from harness_codex.memory_cli import main as memory_main

_REMOVED_TOP_LEVEL_COMMANDS = frozenset({"ultrawork", "change-set-pr"})

COMMAND_HELP: tuple[tuple[str, str], ...] = tuple(
    (
        ("memory", "List, search, or reindex reviewed ChangeSet-first memory.")
        if item[0] == "memory"
        else item
    )
    for item in _stage_runtime.COMMAND_HELP
    if item[0] not in _REMOVED_TOP_LEVEL_COMMANDS
)
PUBLIC_COMMANDS = frozenset(command for command, _ in COMMAND_HELP)
TOPIC_HELP = {
    command: text
    for command, text in _stage_runtime.TOPIC_HELP.items()
    if command not in _REMOVED_TOP_LEVEL_COMMANDS
}
TOPIC_HELP["memory"] = (
    "Usage: harness memory list [--kind KIND]\n"
    "       harness memory search QUERY [--kind KIND] [--change-set ID] [--work-item ID] [--stage STAGE] [--limit N]\n"
    "       harness memory reindex\n\n"
    "Search reviewed ChangeSet-first memory under docs/memory. "
    "Legacy score-based .harness/memory commands are retired."
)


def main(argv: list[str] | None = None) -> int:
    """Run the public workflow without mutating argparse internals."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    command, positional = _public_command(arguments)

    if command is None or command in {"-h", "--help"}:
        print(help_command(None))
        return 0
    if command == "help":
        topic = positional[1] if len(positional) > 1 else None
        print(help_command(topic))
        return 0
    if command == "memory":
        return memory_main(_memory_arguments(arguments))
    if command not in PUBLIC_COMMANDS:
        print(
            f"unknown public harness command: {command}. "
            "Use `harness help` to view supported commands.",
            file=sys.stderr,
        )
        return 2

    return _stage_runtime.main(arguments)


def build_parser() -> argparse.ArgumentParser:
    """Build a lightweight parser for public CLI inspection and integration tests."""

    parser = argparse.ArgumentParser(
        prog="harness",
        description="Harness runtime for the staged workflow in README.md.",
        epilog=_format_command_list(),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("command", nargs="?", choices=tuple(sorted(PUBLIC_COMMANDS)))
    parser.add_argument("command_args", nargs=argparse.REMAINDER)
    return parser


def help_command(topic: str | None) -> str:
    if not topic:
        return "\n".join(("Harness runtime commands", "", _format_command_list()))
    if topic not in TOPIC_HELP:
        raise ValueError(f"unknown public harness command: {topic}")
    return TOPIC_HELP[topic]


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


def _format_command_list() -> str:
    width = max(len(command) for command, _ in COMMAND_HELP)
    lines = ["Commands:"]
    lines.extend(f"  {command.ljust(width)}  {summary}" for command, summary in COMMAND_HELP)
    lines.append("")
    lines.append("README.md defines the supported staged workflow.")
    lines.append("Use `harness help <command>` for command usage.")
    return "\n".join(lines)
