"""Shell completion candidate helpers for the harness CLI."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from harness_codex.runtime.changes import ChangeSetResolver, NoActiveChangeSetsError


@dataclass(frozen=True)
class CompletionCandidate:
    """One shell completion candidate with an optional display description."""

    value: str
    description: str = ""


def run_change_candidates(repo_root: Path | str, prefix: str = "") -> tuple[CompletionCandidate, ...]:
    """Return active ChangeSet IDs for `run-change` completion."""

    normalized_prefix = prefix.strip()
    try:
        change_sets = ChangeSetResolver(Path(repo_root)).list_active()
    except NoActiveChangeSetsError:
        return ()

    return tuple(
        CompletionCandidate(change_set.change_set_id, change_set.title)
        for change_set in change_sets
        if not normalized_prefix or change_set.change_set_id.startswith(normalized_prefix)
    )


def format_candidates(
    candidates: Iterable[CompletionCandidate],
    *,
    shell_format: str,
) -> str:
    """Format candidates for completion scripts."""

    if shell_format == "zsh":
        return "\n".join(
            f"{candidate.value}:{_zsh_description(candidate.description)}"
            for candidate in candidates
        )
    if shell_format == "bash":
        return "\n".join(candidate.value for candidate in candidates)
    if shell_format == "tsv":
        return "\n".join(
            f"{candidate.value}\t{candidate.description}" for candidate in candidates
        )
    raise ValueError(f"unsupported completion format: {shell_format}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python3 -m harness_codex.runtime.shell_completion")
    subparsers = parser.add_subparsers(required=True)

    run_change = subparsers.add_parser("run-change")
    run_change.add_argument("--repo-root", default=".")
    run_change.add_argument("--prefix", default="")
    run_change.add_argument(
        "--format",
        choices=("bash", "zsh", "tsv"),
        default="tsv",
    )
    run_change.set_defaults(func=run_change_completion_command)
    return parser


def run_change_completion_command(args: argparse.Namespace) -> str:
    return format_candidates(
        run_change_candidates(args.repo_root, args.prefix),
        shell_format=args.format,
    )


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    output = args.func(args)
    if output:
        print(output)
    return 0


def _zsh_description(value: str) -> str:
    return value.replace(":", " -") if value else "-"


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
