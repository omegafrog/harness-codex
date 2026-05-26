"""Document-backed browser dashboard state and editable document operations."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.dashboard import DashboardRun, load_dashboard_runs
from harness_codex.runtime.procedure_stages import procedure_stage, update_changeset_stage_status


class DashboardDocumentError(ValueError):
    """Base error for dashboard document operations."""


class DashboardDocumentNotFound(DashboardDocumentError):
    """Raised when a dashboard document identifier is not editable."""


class DashboardDocumentConflict(DashboardDocumentError):
    """Raised when disk content changed since an editor loaded it."""


class DashboardDocumentValidationError(DashboardDocumentError):
    """Raised when edited Markdown would break workflow parsing."""


def document_dashboard_state(repo_root: Path | str) -> dict[str, Any]:
    """Project docs and runtime history into browser dashboard data."""

    root = Path(repo_root)
    runs_by_change_set: dict[str, list[DashboardRun]] = {}
    for run in load_dashboard_runs(root):
        runs_by_change_set.setdefault(run.change_set_id, []).append(run)

    change_sets: list[dict[str, Any]] = []
    for lifecycle in ("active", "completed"):
        change_dir = root / "docs/changes" / lifecycle
        for path in sorted(change_dir.glob("*.md")):
            text = path.read_text(encoding="utf-8")
            change_set = parse_changeset_markdown(text, path=path)
            runs = sorted(
                runs_by_change_set.get(change_set.change_set_id, []),
                key=lambda run: _run_recency(root, run),
                reverse=True,
            )
            run_payloads = [_run_payload(run) for run in runs]
            change_sets.append(
                {
                    "id": change_set.change_set_id,
                    "title": change_set.title,
                    "lifecycle": lifecycle,
                    "intent": change_set.intent_summary,
                    "path": _relative_path(root, path),
                    "stages": _parse_procedure_stages(text),
                    "work_items": [
                        _work_item_payload(root, change_set.change_set_id, lifecycle, item)
                        for item in change_set.ordered_work_items()
                    ],
                    "documents": _document_summaries(root, change_set, lifecycle, path),
                    "latest_run": run_payloads[0] if run_payloads else None,
                    "run_history": run_payloads,
                }
            )
    return {"change_sets": change_sets}


def read_dashboard_document(repo_root: Path | str, document_id: str) -> dict[str, Any]:
    """Read one document exposed by the dashboard."""

    root = Path(repo_root)
    document = _resolve_readable_document(root, document_id)
    content = document["path"].read_text(encoding="utf-8")
    return _document_payload(root, document, content)


def save_dashboard_document(
    repo_root: Path | str,
    document_id: str,
    *,
    content: str,
    revision: str,
) -> dict[str, Any]:
    """Save valid Markdown if the caller still holds the disk revision."""

    root = Path(repo_root)
    document = _resolve_editable_document(root, document_id)
    path = document["path"]
    current = path.read_text(encoding="utf-8")
    if revision != _revision(current):
        raise DashboardDocumentConflict(
            "Document changed on disk. Reload latest content before saving."
        )
    normalized = content.rstrip() + "\n"
    _validate_document(document, normalized)

    change_path = document["change_path"]
    change_text = change_path.read_text(encoding="utf-8")
    for stage_id in _stale_stage_ids(document["kind"]):
        change_text = update_changeset_stage_status(
            change_text,
            stage=procedure_stage(stage_id),
            status="stale",
            notes=f"stale after dashboard edit of {document['kind']}",
        )

    path.write_text(normalized, encoding="utf-8")
    change_path.write_text(change_text, encoding="utf-8")
    return _document_payload(root, document, normalized)


def _work_item_payload(
    root: Path,
    change_set_id: str,
    lifecycle: str,
    item: Any,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": item.work_item_id,
        "type": item.work_item_type.value,
        "name": item.name,
        "status": item.status,
        "artifacts": [],
    }
    if item.work_item_type is not WorkItemType.USE_CASE:
        return payload

    slice_path = root / "docs/use-cases" / item.work_item_id
    artifact_paths = [
        slice_path / "use-case.md",
        slice_path / "event-storming.md",
        slice_path / "ddd-design.md",
        slice_path / "technical-decisions.md",
        slice_path / "e2e-goal.md",
        root / "docs/plans/active" / item.work_item_id / "plan.md",
        root / "docs/plans/completed" / item.work_item_id / "plan.md",
    ]
    payload["artifacts"] = [
        {"path": _relative_path(root, path), "exists": True}
        for path in artifact_paths
        if path.exists()
    ]
    event_path = slice_path / "event-storming.md"
    payload["event_storming"] = (
        _parse_event_storming(event_path.read_text(encoding="utf-8"))
        if event_path.exists()
        else {"flows": []}
    )
    if lifecycle == "active":
        payload["editable_document_id"] = f"use-case:{change_set_id}:{item.work_item_id}"
    return payload


def _document_summaries(
    root: Path,
    change_set: Any,
    lifecycle: str,
    change_path: Path,
) -> list[dict[str, str | bool]]:
    if lifecycle != "active":
        return [
            {
                "id": f"change-set:{change_set.change_set_id}",
                "kind": "change-set",
                "label": "ChangeSet (Read only)",
                "path": _relative_path(root, change_path),
                "editable": False,
            }
        ]
    summaries: list[dict[str, str | bool]] = []
    requirements = root / "docs/design/요구사항.md"
    if requirements.exists():
        summaries.append(
            {
                "id": f"requirements:{change_set.change_set_id}",
                "kind": "requirements",
                "label": "Requirements",
                "path": _relative_path(root, requirements),
                "editable": True,
            }
        )
    for item in change_set.ordered_work_items():
        if item.work_item_type is WorkItemType.USE_CASE:
            path = root / "docs/use-cases" / item.work_item_id / "use-case.md"
            if path.exists():
                summaries.append(
                    {
                        "id": f"use-case:{change_set.change_set_id}:{item.work_item_id}",
                        "kind": "use-case",
                        "label": f"{item.work_item_id} Use Case",
                        "path": _relative_path(root, path),
                        "editable": True,
                    }
                )
    return summaries


def _resolve_readable_document(root: Path, document_id: str) -> dict[str, Any]:
    if document_id.startswith("change-set:"):
        change_set_id = document_id.removeprefix("change-set:")
        if not re.fullmatch(r"CHG-[A-Za-z0-9-]+", change_set_id):
            raise DashboardDocumentNotFound("Unknown completed ChangeSet document.")
        path = root / "docs/changes/completed" / f"{change_set_id}.md"
        if not change_set_id or not path.exists():
            raise DashboardDocumentNotFound("Completed ChangeSet document does not exist.")
        return {
            "id": document_id,
            "kind": "change-set",
            "label": "ChangeSet (Read only)",
            "path": path,
            "editable": False,
        }
    return _resolve_editable_document(root, document_id)


def _resolve_editable_document(root: Path, document_id: str) -> dict[str, Any]:
    parts = document_id.split(":")
    if len(parts) not in (2, 3):
        raise DashboardDocumentNotFound("Unknown editable document.")
    kind, change_set_id = parts[:2]
    change_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_path.exists():
        raise DashboardDocumentNotFound("Only active ChangeSet documents can be edited.")
    change_set = parse_changeset_markdown(
        change_path.read_text(encoding="utf-8"), path=change_path
    )
    if kind == "requirements" and len(parts) == 2:
        path = root / "docs/design/요구사항.md"
        label = "Requirements"
    elif kind == "use-case" and len(parts) == 3:
        uc_id = parts[2]
        if not any(
            item.work_item_type is WorkItemType.USE_CASE and item.work_item_id == uc_id
            for item in change_set.ordered_work_items()
        ):
            raise DashboardDocumentNotFound("Use case is not part of the active ChangeSet.")
        path = root / "docs/use-cases" / uc_id / "use-case.md"
        label = f"{uc_id} Use Case"
    else:
        raise DashboardDocumentNotFound("Unknown editable document.")
    if not path.exists():
        raise DashboardDocumentNotFound("Editable document does not exist.")
    return {
        "id": document_id,
        "kind": kind,
        "label": label,
        "path": path,
        "change_path": change_path,
        "editable": True,
    }


def _document_payload(root: Path, document: dict[str, Any], content: str) -> dict[str, Any]:
    return {
        "id": document["id"],
        "kind": document["kind"],
        "label": document["label"],
        "path": _relative_path(root, document["path"]),
        "content": content,
        "revision": _revision(content),
        "editable": document["editable"],
    }


def _validate_document(document: dict[str, Any], content: str) -> None:
    placeholder_terms = ("TBD from confirmed requirements", "has not been derived yet", "<UC-ID>")
    for term in placeholder_terms:
        if term in content:
            raise DashboardDocumentValidationError(
                f"Document contains unresolved placeholder: {term}"
            )
    if document["kind"] == "requirements":
        required_groups = (
            ("# Requirements", "# 요구사항"),
            ("## 1. Overview", "## 1. 개요"),
            ("## 3. Functional Requirements", "## 3. 기능 요구사항"),
        )
    else:
        uc_id = document["id"].split(":")[-1]
        required_groups = (
            (f"# {uc_id}.",),
            ("## Actor", "- Actor:", "**Actor**"),
            ("## Goal", "- Goal:", "**Goal**"),
            ("## Main Flow", "## 3. Basic Flow", "**Main Flow**"),
            ("## Result", "## 5. Outcomes", "**Result**"),
        )
    missing = ["/".join(group) for group in required_groups if not any(term in content for term in group)]
    if missing:
        raise DashboardDocumentValidationError(
            "Document is missing required structure: " + ", ".join(missing)
        )


def _stale_stage_ids(kind: str) -> tuple[str, ...]:
    if kind == "requirements":
        return (
            "use-case-definition",
            "event-storming",
            "ddd-architecture-definition",
            "technical-decisions",
            "plan-writing",
            "implementation",
        )
    return (
        "event-storming",
        "ddd-architecture-definition",
        "technical-decisions",
        "plan-writing",
        "implementation",
    )


def _parse_procedure_stages(text: str) -> list[dict[str, str]]:
    section = _section_text(text, "## 3. Runtime Procedure State")
    stages: list[dict[str, str]] = []
    for line in section.splitlines():
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) >= 5 and cells[0] not in ("Stage ID", "---"):
            stages.append(
                {
                    "id": cells[0],
                    "procedure": cells[1],
                    "status": cells[2],
                    "verified_at": cells[3],
                    "notes": cells[4].replace("\\|", "|"),
                }
            )
    return stages


def _parse_event_storming(text: str) -> dict[str, Any]:
    flows: list[dict[str, Any]] = []
    matches = list(re.finditer(r"^### \[Flow: ([^\]]+)\]\s*$", text, re.MULTILINE))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        block = text[match.end():end].split("---", 1)[0]
        source_name = match.group(1).strip()
        kind = "main" if "기본" in source_name or "main" in source_name.lower() else "exception"
        notes: list[dict[str, str]] = []
        for line in block.splitlines():
            value = line.strip().removeprefix("→").strip()
            note_type = _sticky_type(value)
            if note_type:
                notes.append({"type": note_type, "text": value[2:].strip()})
        if notes:
            ordinal = sum(1 for flow in flows if flow["kind"] == kind) + 1
            label = "Main Flow" if kind == "main" else f"Exception Flow {ordinal}"
            flows.append(
                {"name": label, "source_name": source_name, "kind": kind, "notes": notes}
            )
    return {"flows": flows}


def _sticky_type(value: str) -> str | None:
    return {
        "🟦": "command",
        "🟧": "event",
        "🟪": "policy",
        "⬛": "system",
        "🟩": "external_system",
    }.get(value[:1])


def _run_payload(run: DashboardRun) -> dict[str, Any]:
    return {
        "run_id": run.run_id,
        "status": run.status.value,
        "report_path": str(run.report_path),
        "work_items": [
            {
                "id": item.work_item_id,
                "type": item.work_item_type.value,
                "current_stage": item.current_stage,
                "status": item.status.value,
                "blocker": item.blocker,
                "verification_result": item.verification_result,
            }
            for item in run.work_items
        ],
    }


def _run_recency(root: Path, run: DashboardRun) -> tuple[int, str]:
    state_path = root / ".harness/runs" / run.run_id / "state.json"
    return ((state_path.stat().st_mtime_ns if state_path.exists() else 0), run.run_id)


def _section_text(text: str, heading: str) -> str:
    start = text.find(heading)
    if start < 0:
        return ""
    body_start = start + len(heading)
    next_heading = re.search(r"^## ", text[body_start:], re.MULTILINE)
    end = body_start + next_heading.start() if next_heading else len(text)
    return text[body_start:end]


def _revision(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _relative_path(root: Path, path: Path) -> str:
    return str(path.relative_to(root))
