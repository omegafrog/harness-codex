"""Validate use-case design visualization artifacts and their source freshness."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


SOURCE_DOCUMENT_FILENAMES = (
    "use-case.md",
    "e2e-goal.md",
    "event-storming.md",
    "ddd-design.md",
    "technical-decisions.md",
)


class DesignVisualizationPaths:
    """Resolved artifact paths for one use-case design visualization."""

    def __init__(self, uc_id: str) -> None:
        self.slice_path = Path("docs/use-cases") / uc_id
        self.class_diagram = self.slice_path / "class-diagram.md"
        self.flow_diagram = self.slice_path / "flow-diagram.md"
        self.metadata = self.slice_path / "diagram-metadata.json"

    @property
    def source_documents(self) -> tuple[Path, ...]:
        return (
            *(self.slice_path / filename for filename in SOURCE_DOCUMENT_FILENAMES),
            Path("context.md"),
            Path("ARCHITECTURE.md"),
        )


def verify_design_visualization(
    repo_root: Path,
    *,
    change_set_id: str,
    uc_id: str,
) -> tuple[bool, tuple[str, ...]]:
    """Return whether diagrams are renderable and derived from current approved inputs."""

    paths = DesignVisualizationPaths(uc_id)
    problems: list[str] = []
    _verify_diagram(
        repo_root,
        paths.class_diagram,
        diagram_kind="class",
        required_tokens=("```mermaid", "classDiagram"),
        problems=problems,
    )
    _verify_diagram(
        repo_root,
        paths.flow_diagram,
        diagram_kind="flow",
        required_tokens=("```mermaid",),
        problems=problems,
    )

    flow_path = repo_root / paths.flow_diagram
    if flow_path.exists() and flow_path.is_file():
        flow_text = flow_path.read_text(encoding="utf-8")
        if not any(token in flow_text for token in ("flowchart", "sequenceDiagram", "stateDiagram")):
            problems.append(
                f"flow diagram has no supported Mermaid flow type: {paths.flow_diagram}"
            )

    metadata = _load_metadata(repo_root, paths.metadata, problems)
    if metadata is not None:
        _verify_metadata_identity(
            metadata,
            change_set_id=change_set_id,
            uc_id=uc_id,
            metadata_path=paths.metadata,
            problems=problems,
        )
        _verify_source_hashes(
            repo_root,
            metadata,
            source_documents=paths.source_documents,
            metadata_path=paths.metadata,
            problems=problems,
        )

    return not problems, tuple(problems)


def _verify_diagram(
    repo_root: Path,
    path: Path,
    *,
    diagram_kind: str,
    required_tokens: tuple[str, ...],
    problems: list[str],
) -> None:
    absolute = repo_root / path
    if not absolute.exists():
        problems.append(f"missing {diagram_kind} diagram: {path}")
        return
    if not absolute.is_file():
        problems.append(f"{diagram_kind} diagram is not a file: {path}")
        return
    text = absolute.read_text(encoding="utf-8").strip()
    if not text:
        problems.append(f"empty {diagram_kind} diagram: {path}")
        return
    for token in required_tokens:
        if token not in text:
            problems.append(
                f"{diagram_kind} diagram missing required Mermaid token {token!r}: {path}"
            )
    for placeholder in ("TBD", "To be derived", "Needs confirmation"):
        if placeholder in text:
            problems.append(
                f"unverified placeholder in {diagram_kind} diagram {path}: {placeholder}"
            )


def _load_metadata(
    repo_root: Path,
    path: Path,
    problems: list[str],
) -> dict[str, object] | None:
    absolute = repo_root / path
    if not absolute.exists():
        problems.append(f"missing diagram metadata: {path}")
        return None
    try:
        loaded = json.loads(absolute.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        problems.append(f"invalid diagram metadata {path}: {exc}")
        return None
    if not isinstance(loaded, dict):
        problems.append(f"diagram metadata must be a JSON object: {path}")
        return None
    return loaded


def _verify_metadata_identity(
    metadata: dict[str, object],
    *,
    change_set_id: str,
    uc_id: str,
    metadata_path: Path,
    problems: list[str],
) -> None:
    if metadata.get("status") != "verified":
        problems.append(
            f"diagram metadata status must be verified: {metadata_path}"
        )
    if metadata.get("uc_id") != uc_id:
        problems.append(
            f"diagram metadata UC does not match {uc_id}: {metadata_path}"
        )
    if metadata.get("change_set_id") != change_set_id:
        problems.append(
            f"diagram metadata ChangeSet does not match {change_set_id}: {metadata_path}"
        )


def _verify_source_hashes(
    repo_root: Path,
    metadata: dict[str, object],
    *,
    source_documents: tuple[Path, ...],
    metadata_path: Path,
    problems: list[str],
) -> None:
    recorded = metadata.get("source_documents")
    if not isinstance(recorded, dict):
        problems.append(f"diagram metadata source_documents must be an object: {metadata_path}")
        return
    for document in source_documents:
        absolute = repo_root / document
        if not absolute.exists():
            problems.append(f"diagram source document is missing: {document}")
            continue
        expected = f"sha256:{_sha256(absolute)}"
        actual = recorded.get(str(document))
        if actual != expected:
            problems.append(
                f"stale diagram source hash for {document}: regenerate design-visualization"
            )


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()
