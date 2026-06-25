"""Validate plan-writing integrated design reports."""

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


class PlanningDesignReportPaths:
    def __init__(self, uc_id: str) -> None:
        self.uc_id = uc_id
        self.slice_path = Path("docs/use-cases") / uc_id
        self.plan_path = Path("docs/plans/active") / uc_id / "plan.md"
        self.report_path = Path("docs/plans/active") / uc_id / "design-report.md"

    @property
    def source_documents(self) -> tuple[Path, ...]:
        return (
            *(self.slice_path / filename for filename in SOURCE_DOCUMENT_FILENAMES),
            Path("context.md"),
            Path("ARCHITECTURE.md"),
        )


def verify_planning_design_report(
    repo_root: Path,
    *,
    change_set_id: str,
    uc_id: str,
) -> tuple[bool, tuple[str, ...]]:
    """Verify the plan-owned report contains both current Mermaid diagrams."""

    paths = PlanningDesignReportPaths(uc_id)
    absolute = repo_root / paths.report_path
    problems: list[str] = []
    if not absolute.exists():
        return False, (f"missing integrated design report: {paths.report_path}",)
    if not absolute.is_file():
        return False, (f"integrated design report is not a file: {paths.report_path}",)
    text = absolute.read_text(encoding="utf-8").strip()
    if not text:
        return False, (f"empty integrated design report: {paths.report_path}",)

    for token in (
        "## Source of Truth",
        "## Class Diagram",
        "## Flow Diagram",
        "## Implementation Plan Alignment",
        "## Evidence Metadata",
        str(paths.plan_path),
        "```mermaid",
        "classDiagram",
    ):
        if token not in text:
            problems.append(
                f"integrated design report missing required token {token!r}: {paths.report_path}"
            )
    if not any(token in text for token in ("flowchart", "sequenceDiagram", "stateDiagram")):
        problems.append(
            f"integrated design report has no supported Mermaid flow type: {paths.report_path}"
        )
    for placeholder in ("TBD", "To be derived", "Needs confirmation"):
        if placeholder in text:
            problems.append(
                f"unverified placeholder in integrated design report {paths.report_path}: {placeholder}"
            )

    metadata = _embedded_metadata(text, paths.report_path, problems)
    if metadata is not None:
        _verify_metadata_identity(metadata, change_set_id, uc_id, paths.report_path, problems)
        _verify_source_hashes(repo_root, metadata, paths, problems)
    return not problems, tuple(problems)


def _embedded_metadata(
    text: str, report_path: Path, problems: list[str]
) -> dict[str, object] | None:
    heading = "## Evidence Metadata"
    start = text.find(heading)
    if start < 0:
        problems.append(f"missing JSON evidence metadata in integrated design report: {report_path}")
        return None
    json_start = text.find("```json", start)
    json_end = text.find("```", json_start + len("```json")) if json_start >= 0 else -1
    if json_start < 0 or json_end < 0:
        problems.append(f"missing JSON evidence metadata in integrated design report: {report_path}")
        return None
    payload = text[json_start + len("```json") : json_end].strip()
    try:
        loaded = json.loads(payload)
    except json.JSONDecodeError as exc:
        problems.append(f"invalid JSON evidence metadata {report_path}: {exc.msg}")
        return None
    if not isinstance(loaded, dict):
        problems.append(f"evidence metadata must be a JSON object: {report_path}")
        return None
    return loaded


def _verify_metadata_identity(
    metadata: dict[str, object],
    change_set_id: str,
    uc_id: str,
    report_path: Path,
    problems: list[str],
) -> None:
    if metadata.get("status") != "verified":
        problems.append(f"integrated design report metadata status must be verified: {report_path}")
    if metadata.get("change_set_id") != change_set_id:
        problems.append(
            f"integrated design report metadata ChangeSet does not match {change_set_id}: {report_path}"
        )
    if metadata.get("uc_id") != uc_id:
        problems.append(f"integrated design report metadata UC does not match {uc_id}: {report_path}")


def _verify_source_hashes(
    repo_root: Path,
    metadata: dict[str, object],
    paths: PlanningDesignReportPaths,
    problems: list[str],
) -> None:
    recorded = metadata.get("source_documents")
    if not isinstance(recorded, dict):
        problems.append(
            f"integrated design report metadata source_documents must be an object: {paths.report_path}"
        )
        return
    for document in paths.source_documents:
        absolute = repo_root / document
        if not absolute.exists():
            problems.append(f"integrated design report source document is missing: {document}")
            continue
        expected = f"sha256:{hashlib.sha256(absolute.read_bytes()).hexdigest()}"
        if recorded.get(str(document)) != expected:
            problems.append(
                f"stale integrated design report source hash for {document}: rerun plan-writing"
            )
