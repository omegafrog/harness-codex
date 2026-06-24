"""Public CLI for ChangeSet-first long-term memory.

This command replaces the legacy `.harness/memory` index and score workflow.
It deliberately exposes read/search/reindex operations only; durable writes come
from reviewed completed ChangeSets or `harness evolution accept`.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from harness_codex.runtime.changeset_memory import (
    ChangeSetMemoryError,
    load_memory_documents,
    rebuild_memory_index,
    search_memory,
)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = Path(args.repo_root)
    try:
        output = args.func(args, root)
    except (ChangeSetMemoryError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    if output:
        print(output)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness memory",
        description="Search reviewed ChangeSet-first long-term memory.",
    )
    parser.add_argument("--repo-root", default=".")
    commands = parser.add_subparsers(dest="memory_command", required=True)

    list_command = commands.add_parser("list", help="List verified memory documents.")
    list_command.add_argument("--kind", choices=(
        "completed_changeset", "decision", "failure_pattern", "review_learning"
    ))
    list_command.set_defaults(func=list_command_handler)

    search_command = commands.add_parser("search", help="Search verified memory with BM25.")
    search_command.add_argument("query")
    search_command.add_argument("--kind", choices=(
        "completed_changeset", "decision", "failure_pattern", "review_learning"
    ))
    search_command.add_argument("--change-set", default="")
    search_command.add_argument("--work-item", default="")
    search_command.add_argument("--stage", choices=("plan", "execute", "verify"))
    search_command.add_argument("--limit", type=int, default=5)
    search_command.set_defaults(func=search_command_handler)

    reindex_command = commands.add_parser("reindex", help="Regenerate ignored lexical index.")
    reindex_command.set_defaults(func=reindex_command_handler)
    return parser


def list_command_handler(args: argparse.Namespace, root: Path) -> str:
    documents = [
        document
        for document in load_memory_documents(root)
        if not args.kind or document.kind == args.kind
    ]
    if not documents:
        return "No verified ChangeSet-first memory documents found"
    return "\n".join(
        "\t".join(
            (
                document.memory_id,
                document.kind,
                document.status,
                str(document.document_path),
                document.change_set_id or "-",
                document.work_item_id or "-",
                document.repository_revision,
            )
        )
        for document in documents
    )


def search_command_handler(args: argparse.Namespace, root: Path) -> str:
    hits = search_memory(
        root,
        args.query,
        kind=args.kind,
        change_set_id=args.change_set.strip() or None,
        work_item_id=args.work_item.strip() or None,
        stage=args.stage,
        limit=args.limit,
    )
    if not hits:
        return "No matching verified ChangeSet-first memory documents found"
    return "\n".join(
        "\t".join(
            (
                hit.document.memory_id,
                hit.document.kind,
                f"score={hit.score:.3f}",
                f"confidence={hit.confidence}",
                f"reference_only={str(hit.reference_only).lower()}",
                f"matched={_matched(hit.rank_reasons)}",
                f"source={hit.document.source_path}",
                f"revision={hit.document.repository_revision}",
            )
        )
        for hit in hits
    )


def reindex_command_handler(_args: argparse.Namespace, root: Path) -> str:
    return f"Rebuilt ChangeSet-first memory index: {rebuild_memory_index(root)}"


def _matched(reasons: tuple[str, ...]) -> str:
    return next(
        (reason.removeprefix("matched=") for reason in reasons if reason.startswith("matched=")),
        "",
    )
