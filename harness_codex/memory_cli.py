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
from harness_codex.runtime.file_memory_cache import (
    DEFAULT_MAX_BYTES,
    FileMemoryCacheError,
    clear_file_cache,
    file_cache_stats,
    read_file_cache,
    warm_file_cache,
)
from harness_codex.runtime.graph_context import (
    GraphContextError,
    build_graph_context,
    graph_context_status,
    query_graph_context,
    rebuild_graph_context,
)


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    root = Path(args.repo_root)
    try:
        output = args.func(args, root)
    except (ChangeSetMemoryError, FileMemoryCacheError, GraphContextError, ValueError) as error:
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

    cache_command = commands.add_parser("cache", help="Read and warm run-local file snapshots.")
    cache_subcommands = cache_command.add_subparsers(dest="cache_command", required=True)
    cache_read = cache_subcommands.add_parser("read", help="Read one file through the cache.")
    cache_read.add_argument("path")
    cache_read.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    cache_read.add_argument("--metadata", action="store_true")
    cache_read.set_defaults(func=cache_read_command_handler)
    cache_warm = cache_subcommands.add_parser("warm", help="Warm file snapshots.")
    cache_warm.add_argument("paths", nargs="+")
    cache_warm.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES)
    cache_warm.set_defaults(func=cache_warm_command_handler)
    cache_stats = cache_subcommands.add_parser("stats", help="Show file cache stats.")
    cache_stats.set_defaults(func=cache_stats_command_handler)
    cache_clear = cache_subcommands.add_parser("clear", help="Clear file cache snapshots.")
    cache_clear.set_defaults(func=cache_clear_command_handler)

    graph_command = commands.add_parser("graph", help="Build and query external graph context.")
    graph_subcommands = graph_command.add_subparsers(dest="graph_command", required=True)
    graph_status = graph_subcommands.add_parser("status", help="Show graph context status.")
    graph_status.set_defaults(func=graph_status_command_handler)
    graph_build = graph_subcommands.add_parser("build", help="Build graph context with graphify.")
    graph_build.add_argument("paths", nargs="*")
    graph_build.add_argument("--backend", choices=("gemini", "kimi", "claude", "openai", "ollama"))
    graph_build.add_argument("--model")
    graph_build.add_argument("--token-budget", type=int)
    graph_build.add_argument("--no-cluster", action="store_true")
    graph_build.set_defaults(func=graph_build_command_handler)
    graph_rebuild = graph_subcommands.add_parser("rebuild", help="Rebuild graph context from the last build manifest.")
    graph_rebuild.set_defaults(func=graph_rebuild_command_handler)
    graph_query = graph_subcommands.add_parser("query", help="Query graph context with graphify.")
    graph_query.add_argument("query")
    graph_query.add_argument("--budget", type=int, default=1200)
    graph_query.add_argument("--dfs", action="store_true")
    graph_query.set_defaults(func=graph_query_command_handler)
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


def cache_read_command_handler(args: argparse.Namespace, root: Path) -> str:
    result = read_file_cache(root, args.path, max_bytes=args.max_bytes)
    if not args.metadata:
        return result.content
    return "\n".join(
        [
            f"path={result.path}",
            f"cache_hit={str(result.cache_hit).lower()}",
            f"sha256={result.sha256}",
            f"size={result.size}",
            f"cache_file={result.cache_file}",
        ]
    )


def cache_warm_command_handler(args: argparse.Namespace, root: Path) -> str:
    result = warm_file_cache(root, args.paths, max_bytes=args.max_bytes)
    lines = [
        f"warmed={result.warmed}",
        f"hits={result.hits}",
        f"refreshed={result.refreshed}",
        f"skipped={len(result.skipped)}",
    ]
    lines.extend(f"skip={item}" for item in result.skipped)
    return "\n".join(lines)


def cache_stats_command_handler(_args: argparse.Namespace, root: Path) -> str:
    stats = file_cache_stats(root)
    return "\n".join(f"{key}={value}" for key, value in stats.items())


def cache_clear_command_handler(_args: argparse.Namespace, root: Path) -> str:
    return f"removed={clear_file_cache(root)}"


def graph_status_command_handler(_args: argparse.Namespace, root: Path) -> str:
    status = graph_context_status(root)
    return "\n".join(
        [
            f"exists={str(status.exists).lower()}",
            f"graph_path={status.graph_path}",
            f"nodes={status.nodes}",
            f"edges={status.edges}",
            f"communities={status.communities}",
            f"stale={str(status.stale).lower()}",
            f"tracked_files={status.tracked_files}",
            f"changed_files={status.changed_files}",
            f"missing_files={status.missing_files}",
            f"new_files={status.new_files}",
        ]
    )


def graph_build_command_handler(args: argparse.Namespace, root: Path) -> str:
    result = build_graph_context(
        root,
        args.paths,
        backend=args.backend,
        model=args.model,
        token_budget=args.token_budget,
        no_cluster=args.no_cluster,
    )
    lines = [
        f"graph_path={result.graph_path}",
        f"indexed_paths={len(result.indexed_paths)}",
        f"tracked_files={result.tracked_files}",
    ]
    lines.extend(f"path={path}" for path in result.indexed_paths)
    if result.stdout:
        lines.append("graphify_stdout_preview=" + result.stdout[:500].replace("\n", " | "))
    return "\n".join(lines)


def graph_rebuild_command_handler(_args: argparse.Namespace, root: Path) -> str:
    result = rebuild_graph_context(root)
    lines = [
        f"graph_path={result.graph_path}",
        f"indexed_paths={len(result.indexed_paths)}",
        f"tracked_files={result.tracked_files}",
    ]
    lines.extend(f"path={path}" for path in result.indexed_paths)
    if result.stdout:
        lines.append("graphify_stdout_preview=" + result.stdout[:500].replace("\n", " | "))
    return "\n".join(lines)


def graph_query_command_handler(args: argparse.Namespace, root: Path) -> str:
    return query_graph_context(root, args.query, budget=args.budget, dfs=args.dfs)


def _matched(reasons: tuple[str, ...]) -> str:
    return next(
        (reason.removeprefix("matched=") for reason in reasons if reason.startswith("matched=")),
        "",
    )
