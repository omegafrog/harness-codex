"""README-aligned public harness CLI.

The supported workflow is the staged sequence documented in README.md.  This
module intentionally exposes the existing stage handlers without exposing the
parallel one-shot orchestration commands.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Iterable

from harness_codex import cli as _stage_runtime
from harness_codex.runtime.changes import DesignBridgeError, NoActiveChangeSetsError
from harness_codex.runtime.memory import MemoryError
from harness_codex.runtime.workflows import WorkflowMaterializationError

_REMOVED_TOP_LEVEL_COMMANDS = frozenset({"ultrawork", "change-set-pr"})

COMMAND_HELP: tuple[tuple[str, str], ...] = tuple(
    item
    for item in _stage_runtime.COMMAND_HELP
    if item[0] not in _REMOVED_TOP_LEVEL_COMMANDS
)

TOPIC_HELP = {
    command: text
    for command, text in _stage_runtime.TOPIC_HELP.items()
    if command not in _REMOVED_TOP_LEVEL_COMMANDS
}


def main(argv: list[str] | None = None) -> int:
    """Run only the README-defined stage workflow and supporting operations."""

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
    """Build the established parser after pruning non-README workflow entries."""

    parser = _stage_runtime.build_parser()
    _remove_top_level_commands(parser, _REMOVED_TOP_LEVEL_COMMANDS)
    parser.description = "Harness runtime for the staged workflow in README.md."
    parser.epilog = _format_command_list()
    _configure_help_parser(parser)
    return parser


def help_command(args: argparse.Namespace, _repo_root: Path) -> str:
    if not args.topic:
        return "\n".join(("Harness runtime commands", "", _format_command_list()))
    return TOPIC_HELP[args.topic]


def _remove_top_level_commands(parser: argparse.ArgumentParser, names: Iterable[str]) -> None:
    for action in parser._actions:
        if not isinstance(action, argparse._SubParsersAction):
            continue
        for name in names:
            action.choices.pop(name, None)
            action._name_parser_map.pop(name, None)
        action._choices_actions = [
            choice_action
            for choice_action in action._choices_actions
            if choice_action.dest not in names
        ]


def _configure_help_parser(parser: argparse.ArgumentParser) -> None:
    for action in parser._actions:
        if not isinstance(action, argparse._SubParsersAction):
            continue
        help_parser = action.choices.get("help")
        if help_parser is None:
            return
        help_parser.set_defaults(func=help_command)
        for help_action in help_parser._actions:
            if help_action.dest == "topic":
                help_action.choices = tuple(TOPIC_HELP)
        return


def _format_command_list() -> str:
    width = max(len(command) for command, _ in COMMAND_HELP)
    lines = ["Commands:"]
    lines.extend(f"  {command.ljust(width)}  {summary}" for command, summary in COMMAND_HELP)
    lines.append("")
    lines.append("README.md defines the supported staged workflow.")
    lines.append("Use `harness help <command>` for command usage.")
    return "\n".join(lines)
