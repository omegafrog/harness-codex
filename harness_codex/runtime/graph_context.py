"""External graph context integration for workflow agents.

This module deliberately delegates graph construction and traversal to the
installed ``graphify`` CLI. Harness owns only repository-safe staging,
command routing, and compact status output.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence
import hashlib

GRAPH_CONTEXT_ROOT = Path(".harness/graph-context")
GRAPHIFY_OUT = GRAPH_CONTEXT_ROOT / "graphify-out"
GRAPH_PATH = GRAPHIFY_OUT / "graph.json"
CORPUS_ROOT = GRAPH_CONTEXT_ROOT / "corpus"
HARNESS_GRAPH_MANIFEST = GRAPH_CONTEXT_ROOT / "harness-graph-manifest.json"
DEFAULT_GRAPH_BACKEND = "ollama"
DEFAULT_GRAPH_PATHS = (
    Path("docs/design"),
    Path("docs/use-cases"),
    Path("docs/maintenance"),
    Path("docs/plans"),
    Path("harness_codex"),
    Path("tests"),
)
IGNORED_PARTS = frozenset(
    {
        ".git",
        ".gradle",
        ".harness/graph-context",
        "__pycache__",
        "bin",
        "build",
        "node_modules",
        "target",
    }
)


class GraphContextError(ValueError):
    """Raised when graph context cannot be built or queried."""


@dataclass(frozen=True)
class GraphContextStatus:
    graph_path: Path
    exists: bool
    nodes: int = 0
    edges: int = 0
    communities: int = 0
    stale: bool = False
    tracked_files: int = 0
    changed_files: int = 0
    missing_files: int = 0
    new_files: int = 0


@dataclass(frozen=True)
class GraphBuildResult:
    graph_path: Path
    indexed_paths: tuple[str, ...]
    stdout: str
    tracked_files: int = 0


def graph_context_status(repo_root: Path | str) -> GraphContextStatus:
    root = Path(repo_root)
    graph_path = root / GRAPH_PATH
    if not graph_path.is_file():
        return GraphContextStatus(graph_path=GRAPH_PATH, exists=False)
    payload = _load_graph(graph_path)
    nodes = payload.get("nodes", [])
    edges = payload.get("edges")
    if not isinstance(edges, list):
        edges = payload.get("links", [])
    communities = payload.get("communities", [])
    community_count = len(communities) if isinstance(communities, list) else 0
    if community_count == 0 and isinstance(nodes, list):
        community_count = len(
            {
                node.get("community")
                for node in nodes
                if isinstance(node, dict) and node.get("community") is not None
            }
        )
    stale = _stale_summary(root)
    return GraphContextStatus(
        graph_path=GRAPH_PATH,
        exists=True,
        nodes=len(nodes) if isinstance(nodes, list) else 0,
        edges=len(edges) if isinstance(edges, list) else 0,
        communities=community_count,
        stale=stale["stale"],
        tracked_files=stale["tracked_files"],
        changed_files=stale["changed_files"],
        missing_files=stale["missing_files"],
        new_files=stale["new_files"],
    )


def build_graph_context(
    repo_root: Path | str,
    paths: Sequence[str | Path] = (),
    *,
    backend: str | None = None,
    model: str | None = None,
    token_budget: int | None = None,
    no_cluster: bool = False,
) -> GraphBuildResult:
    root = Path(repo_root).resolve()
    graphify = shutil.which("graphify")
    if graphify is None:
        raise GraphContextError("graphify CLI not found. Install graphify before building graph context.")

    selected = _selected_paths(root, paths)
    if not selected:
        raise GraphContextError("no graph context source paths exist")
    corpus = _stage_corpus(root, selected)
    resolved_backend = backend or DEFAULT_GRAPH_BACKEND
    resolved_model = model or _default_ollama_model(root) if resolved_backend == "ollama" else model

    command = [graphify, "extract", str(corpus), "--out", str(root / GRAPH_CONTEXT_ROOT)]
    command.extend(["--backend", resolved_backend])
    if resolved_model:
        command.extend(["--model", resolved_model])
    if token_budget is not None:
        command.extend(["--token-budget", str(token_budget)])
    if no_cluster:
        command.append("--no-cluster")

    completed = subprocess.run(
        command,
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise GraphContextError(f"graphify extract failed: {detail}")
    if not (root / GRAPH_PATH).is_file():
        raise GraphContextError(f"graphify did not create {GRAPH_PATH}")
    snapshot = _source_snapshot(root, selected)
    _write_harness_manifest(
        root,
        {
            "version": 1,
            "built_at": datetime.now(timezone.utc).isoformat(),
            "graph_path": str(GRAPH_PATH),
            "paths": [str(path.relative_to(root)) for path in selected],
            "backend": resolved_backend,
            "model": resolved_model,
            "token_budget": token_budget,
            "no_cluster": no_cluster,
            "files": snapshot,
        },
    )
    return GraphBuildResult(
        graph_path=GRAPH_PATH,
        indexed_paths=tuple(str(path.relative_to(root)) for path in selected),
        stdout=completed.stdout.strip(),
        tracked_files=len(snapshot),
    )


def rebuild_graph_context(repo_root: Path | str) -> GraphBuildResult:
    root = Path(repo_root).resolve()
    manifest = _read_harness_manifest(root)
    if not manifest:
        raise GraphContextError("graph context manifest not found; run graph build first")
    paths = manifest.get("paths", [])
    if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
        raise GraphContextError("graph context manifest has invalid paths")
    return build_graph_context(
        root,
        paths,
        backend=_optional_str(manifest.get("backend")),
        model=_optional_str(manifest.get("model")),
        token_budget=_optional_int(manifest.get("token_budget")),
        no_cluster=bool(manifest.get("no_cluster", False)),
    )


def query_graph_context(
    repo_root: Path | str,
    query: str,
    *,
    budget: int = 1200,
    dfs: bool = False,
) -> str:
    root = Path(repo_root).resolve()
    graphify = shutil.which("graphify")
    if graphify is None:
        raise GraphContextError("graphify CLI not found. Install graphify before querying graph context.")
    graph_path = root / GRAPH_PATH
    if not graph_path.is_file():
        raise GraphContextError(f"graph context not built: {GRAPH_PATH}")
    if not query.strip():
        raise GraphContextError("graph query is required")
    if budget < 100:
        raise GraphContextError("graph query budget must be at least 100")

    command = [
        graphify,
        "query",
        query,
        "--graph",
        str(graph_path),
        "--budget",
        str(budget),
    ]
    if dfs:
        command.append("--dfs")
    completed = subprocess.run(
        command,
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise GraphContextError(f"graphify query failed: {detail}")
    return completed.stdout.strip()


def render_graph_context_guidance(repo_root: Path | str) -> str:
    status = graph_context_status(repo_root)
    lines = [
        "Graph context is external Graphify output. Use it as retrieval aid, never source of truth.",
        "Prefer graph query before broad scans of design docs or source code.",
        "Commands:",
        "- `harness memory graph status`",
        "- `harness memory graph query \"QUESTION\" --budget 1200`",
        "- `harness memory graph build [PATH...]` (defaults to local `--backend ollama`)",
    ]
    if status.exists:
        lines.append(
            f"Available: `{status.graph_path}` nodes={status.nodes} edges={status.edges} communities={status.communities} stale={str(status.stale).lower()}"
        )
    else:
        lines.append(f"Unavailable: build `{status.graph_path}` first.")
    return "\n".join(lines)


def _selected_paths(root: Path, paths: Sequence[str | Path]) -> tuple[Path, ...]:
    candidates = tuple(Path(path) for path in paths) or DEFAULT_GRAPH_PATHS
    selected: list[Path] = []
    for candidate in candidates:
        relative = _repo_relative_path(root, candidate)
        absolute = root / relative
        if absolute.exists():
            selected.append(absolute)
    return tuple(selected)


def _stage_corpus(root: Path, paths: Sequence[Path]) -> Path:
    corpus = root / CORPUS_ROOT
    if corpus.exists():
        shutil.rmtree(corpus)
    corpus.mkdir(parents=True)
    for index, source in enumerate(paths, start=1):
        name = f"{index:02d}-{_safe_name(source.relative_to(root))}"
        target = corpus / name
        if source.is_dir():
            shutil.copytree(
                source,
                target,
                ignore=shutil.ignore_patterns(
                    ".git",
                    ".gradle",
                    "__pycache__",
                    "*.pyc",
                    "bin",
                    "build",
                    "node_modules",
                    "target",
                ),
            )
        else:
            shutil.copy2(source, target)
    return corpus


def _repo_relative_path(root: Path, path: str | Path) -> Path:
    candidate = Path(path)
    if candidate.is_absolute():
        try:
            candidate = candidate.resolve().relative_to(root)
        except ValueError as error:
            raise GraphContextError(f"graph context path is outside repo: {path}") from error
    if any(part == ".." for part in candidate.parts):
        raise GraphContextError(f"graph context path must stay inside repo: {path}")
    if not candidate.parts:
        raise GraphContextError("graph context path is empty")
    return candidate


def _safe_name(path: Path) -> str:
    return "-".join(part.replace(".", "_") for part in path.parts)


def _load_graph(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise GraphContextError("graph context payload must be a JSON object")
    return data


def _default_ollama_model(root: Path) -> str | None:
    if shutil.which("ollama") is None:
        raise GraphContextError(
            "local graph build requires ollama. Install/start ollama or pass an explicit non-local --backend."
        )
    completed = subprocess.run(
        ["ollama", "list"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    if completed.returncode != 0:
        raise GraphContextError(f"ollama list failed: {(completed.stderr or completed.stdout).strip()}")
    for line in completed.stdout.splitlines()[1:]:
        parts = line.split()
        if parts:
            return parts[0]
    raise GraphContextError("no local ollama model found. Run `ollama pull qwen3.5:9b` or pass --model.")


def _write_harness_manifest(root: Path, payload: dict[str, Any]) -> None:
    path = root / HARNESS_GRAPH_MANIFEST
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _read_harness_manifest(root: Path) -> dict[str, Any]:
    path = root / HARNESS_GRAPH_MANIFEST
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, dict) else {}


def _source_snapshot(root: Path, paths: Sequence[Path]) -> dict[str, dict[str, Any]]:
    snapshot: dict[str, dict[str, Any]] = {}
    for source in paths:
        files = [source] if source.is_file() else sorted(path for path in source.rglob("*") if path.is_file())
        for file_path in files:
            relative = file_path.relative_to(root).as_posix()
            if _ignored(relative):
                continue
            raw = file_path.read_bytes()
            snapshot[relative] = {
                "sha256": hashlib.sha256(raw).hexdigest(),
                "size": len(raw),
            }
    return snapshot


def _stale_summary(root: Path) -> dict[str, Any]:
    manifest = _read_harness_manifest(root)
    files = manifest.get("files", {})
    paths = manifest.get("paths", [])
    if not isinstance(files, dict) or not isinstance(paths, list):
        return {
            "stale": False,
            "tracked_files": 0,
            "changed_files": 0,
            "missing_files": 0,
            "new_files": 0,
        }
    selected = _selected_paths(root, [str(path) for path in paths if isinstance(path, str)])
    current = _source_snapshot(root, selected)
    changed = 0
    missing = 0
    for relative, metadata in files.items():
        if not isinstance(metadata, dict):
            changed += 1
            continue
        current_metadata = current.get(str(relative))
        if current_metadata is None:
            missing += 1
        elif current_metadata.get("sha256") != metadata.get("sha256"):
            changed += 1
    new = len(set(current) - {str(path) for path in files})
    return {
        "stale": bool(changed or missing or new),
        "tracked_files": len(files),
        "changed_files": changed,
        "missing_files": missing,
        "new_files": new,
    }


def _ignored(relative: str) -> bool:
    parts = relative.split("/")
    return any(part in IGNORED_PARTS for part in parts)


def _optional_str(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) else None
