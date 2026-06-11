"""Document-backed browser dashboard state and editable document operations."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.document_metadata import (
    ensure_generated_document_metadata,
    parse_front_matter,
)
from harness_codex.runtime.dashboard import DashboardRun, load_dashboard_runs
from harness_codex.runtime.procedure_stages import (
    parse_procedure_stage_rows,
    procedure_stage,
    update_changeset_stage_status,
)
from harness_codex.runtime.state import (
    RunState,
    RunStateStore,
    reconcile_procedure_stage_rows,
    runtime_stage_projection,
)

SCOPED_UI_STATE_ROOT = Path(".harness/ui/change-sets")


class DashboardDocumentError(ValueError):
    """Base error for dashboard document operations."""


class DashboardDocumentNotFound(DashboardDocumentError):
    """Raised when a dashboard document identifier is not editable."""


class DashboardDocumentConflict(DashboardDocumentError):
    """Raised when disk content changed since an editor loaded it."""


class DashboardDocumentValidationError(DashboardDocumentError):
    """Raised when edited Markdown would break workflow parsing."""


class DashboardChangeSetNotFound(DashboardDocumentError):
    """Raised when one active ChangeSet cannot be deleted."""


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
            latest_run_state = _load_run_state(root, runs[0].run_id) if runs else None
            workflow_state = _scoped_workflow_state(root, change_set.change_set_id, lifecycle)
            change_sets.append(
                {
                    "id": change_set.change_set_id,
                    "title": change_set.title,
                    "lifecycle": lifecycle,
                    "intent": change_set.intent_summary,
                    "path": _relative_path(root, path),
                    "stages": _project_workflow_stages(
                        _parse_procedure_stages(text),
                        workflow_state,
                        latest_run_state,
                    ),
                    "work_items": [
                        _work_item_payload(root, change_set.change_set_id, lifecycle, item)
                        for item in change_set.ordered_work_items()
                    ],
                    "documents": _document_summaries(root, change_set, lifecycle, path, workflow_state),
                    "event_storming_board": _scoped_event_storming_board(
                        root, change_set.change_set_id, lifecycle, workflow_state
                    ),
                    "ddd_architecture_board": _scoped_ddd_architecture_board(
                        root, change_set.change_set_id, lifecycle, workflow_state
                    ),
                    "latest_run": run_payloads[0] if run_payloads else None,
                    "run_history": run_payloads,
                }
            )
    return {"change_sets": change_sets}


def delete_active_changeset(repo_root: Path | str, change_set_id: str) -> dict[str, str]:
    """Delete one selected active ChangeSet; preserve separately managed artifacts."""

    root = Path(repo_root)
    if not re.fullmatch(r"CHG-[A-Za-z0-9-]+", change_set_id):
        raise DashboardChangeSetNotFound("Unknown active ChangeSet.")
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not path.exists():
        raise DashboardChangeSetNotFound("Active ChangeSet does not exist.")
    path.unlink()
    return {"id": change_set_id, "deleted_path": _relative_path(root, path)}


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
    relative_path = path.relative_to(root)
    parts = document_id.split(":")
    ensure_generated_document_metadata(
        root,
        relative_path,
        change_set_id=parts[1] if len(parts) > 1 else "",
        work_item_id=parts[2] if len(parts) > 2 else "",
        status="ready",
    )
    normalized = path.read_text(encoding="utf-8")
    change_path.write_text(change_text, encoding="utf-8")
    if document["kind"] == "generated-use-case":
        _invalidate_scoped_event_storming(root, document_id.split(":")[1], document_id.split(":")[2])
    elif document["kind"] == "event-storming":
        _invalidate_scoped_ddd_architecture(root, document_id.split(":")[1], document_id.split(":")[2])
    elif document["kind"] == "ddd-design":
        _stale_ddd_steps_after_edit(
            root, document_id.split(":")[1], document_id.split(":")[2], current, normalized
        )
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
    workflow_state: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    if lifecycle != "active":
        return [
            _with_document_metadata(
                root,
                change_path,
                {
                    "id": f"change-set:{change_set.change_set_id}",
                    "kind": "change-set",
                    "label": "ChangeSet (Read only)",
                    "path": _relative_path(root, change_path),
                    "editable": False,
                },
            )
        ]
    summaries: list[dict[str, Any]] = []
    requirements = root / "docs/design/요구사항.md"
    if requirements.exists():
        summaries.append(
            _with_document_metadata(
                root,
                requirements,
                {
                    "id": f"requirements:{change_set.change_set_id}",
                    "kind": "requirements",
                    "label": "Requirements",
                    "path": _relative_path(root, requirements),
                    "editable": True,
                },
            )
        )
    scoped_root = root / SCOPED_UI_STATE_ROOT / change_set.change_set_id
    use_cases = scoped_root / "docs/design/유스케이스.md"
    if workflow_state and workflow_state.get("use_cases_ready") and use_cases.exists():
        summaries.append(
            _with_document_metadata(
                root,
                use_cases,
                {
                    "id": f"generated-use-cases:{change_set.change_set_id}",
                    "kind": "generated-use-cases",
                    "label": "Use Cases (Read only)",
                    "path": _relative_path(root, use_cases),
                    "editable": False,
                },
            )
        )
    declared_use_case_ids = {
        item.work_item_id
        for item in change_set.ordered_work_items()
        if item.work_item_type is WorkItemType.USE_CASE
    }
    if workflow_state and workflow_state.get("use_cases_ready"):
        for path in sorted((scoped_root / "docs/use-cases").glob("UC-*/use-case.md")):
            uc_id = path.parent.name
            if uc_id not in declared_use_case_ids:
                summaries.append(
                    _with_document_metadata(
                        root,
                        path,
                        {
                            "id": f"generated-use-case:{change_set.change_set_id}:{uc_id}",
                            "kind": "generated-use-case",
                            "label": f"{uc_id} Use Case",
                            "path": _relative_path(root, path),
                            "editable": True,
                        },
                    )
                )
    event_state = (workflow_state or {}).get("event_storming") or {}
    for uc_id in event_state.get("uc_ids", []):
        item = event_state.get("items", {}).get(uc_id, {})
        path = scoped_root / "docs/use-cases" / uc_id / "event-storming.md"
        if item.get("status") == "complete" and path.exists():
            summaries.append(
                _with_document_metadata(
                    root,
                    path,
                    {
                        "id": f"event-storming:{change_set.change_set_id}:{uc_id}",
                        "kind": "event-storming",
                        "label": f"{uc_id} Event Storming",
                        "path": _relative_path(root, path),
                        "editable": True,
                    },
                )
            )
    ddd_state = (workflow_state or {}).get("ddd_architecture") or {}
    for uc_id in ddd_state.get("uc_ids", []):
        item = ddd_state.get("items", {}).get(uc_id, {})
        path = scoped_root / "docs/use-cases" / uc_id / "ddd-design.md"
        if any(step.get("status") == "complete" for step in item.get("steps", {}).values()) and path.exists():
            summaries.append(
                _with_document_metadata(
                    root,
                    path,
                    {
                        "id": f"ddd-design:{change_set.change_set_id}:{uc_id}",
                        "kind": "ddd-design",
                        "label": f"{uc_id} DDD Design",
                        "path": _relative_path(root, path),
                        "editable": True,
                    },
                )
            )
    for item in change_set.ordered_work_items():
        if item.work_item_type is WorkItemType.USE_CASE:
            path = root / "docs/use-cases" / item.work_item_id / "use-case.md"
            if path.exists():
                summaries.append(
                    _with_document_metadata(
                        root,
                        path,
                        {
                            "id": f"use-case:{change_set.change_set_id}:{item.work_item_id}",
                            "kind": "use-case",
                            "label": f"{item.work_item_id} Use Case",
                            "path": _relative_path(root, path),
                            "editable": True,
                        },
                    )
                )
            decisions_path = root / "docs/use-cases" / item.work_item_id / "technical-decisions.md"
            if decisions_path.exists():
                summaries.append(
                    _with_document_metadata(
                        root,
                        decisions_path,
                        {
                            "id": (
                                f"technical-decisions:{change_set.change_set_id}:"
                                f"{item.work_item_id}"
                            ),
                            "kind": "technical-decisions",
                            "label": f"{item.work_item_id} Technical Decisions",
                            "path": _relative_path(root, decisions_path),
                            "editable": True,
                        },
                    )
                )
    return summaries


def _with_document_metadata(root: Path, path: Path, payload: dict[str, Any]) -> dict[str, Any]:
    try:
        metadata = parse_front_matter(path.read_text(encoding="utf-8"))
    except OSError:
        metadata = {}
    if metadata:
        payload["metadata"] = metadata
        payload["doc_type"] = metadata.get("doc_type", "")
        payload["approval_status"] = metadata.get("approval_status", "")
        payload["contract_version"] = metadata.get("contract_version", "")
    payload.setdefault("path", _relative_path(root, path))
    return payload


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
    if document_id.startswith("generated-use-cases:"):
        change_set_id = document_id.removeprefix("generated-use-cases:")
        if not re.fullmatch(r"CHG-[A-Za-z0-9-]+", change_set_id):
            raise DashboardDocumentNotFound("Unknown generated Use Cases document.")
        change_path = root / "docs/changes/active" / f"{change_set_id}.md"
        path = root / SCOPED_UI_STATE_ROOT / change_set_id / "docs/design/유스케이스.md"
        state = _scoped_workflow_state(root, change_set_id, "active")
        if not change_path.exists() or not path.exists() or not state or not state.get("use_cases_ready"):
            raise DashboardDocumentNotFound("Generated Use Cases document does not exist.")
        return {
            "id": document_id,
            "kind": "generated-use-cases",
            "label": "Use Cases (Read only)",
            "path": path,
            "editable": False,
        }
    return _resolve_editable_document(root, document_id)


def _scoped_workflow_state(root: Path, change_set_id: str, lifecycle: str) -> dict[str, Any] | None:
    if lifecycle != "active":
        return None
    path = root / SCOPED_UI_STATE_ROOT / change_set_id / "harvest-session.json"
    if not path.exists():
        return None
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return state if isinstance(state, dict) else None


def _invalidate_scoped_event_storming(root: Path, change_set_id: str, uc_id: str) -> None:
    session_path = root / SCOPED_UI_STATE_ROOT / change_set_id / "harvest-session.json"
    state = _scoped_workflow_state(root, change_set_id, "active")
    event_state = (state or {}).get("event_storming")
    if not isinstance(event_state, dict) or uc_id not in event_state.get("items", {}):
        return
    item = event_state["items"][uc_id]
    item.update({"status": "pending", "current_question": None, "clarifications": [], "error": ""})
    event_state["complete"] = False
    event_state["status"] = "pending"
    event_state["completed_count"] = sum(
        1 for value in event_state["items"].values() if value.get("status") == "complete"
    )
    event_state["current_uc"] = uc_id
    output = root / SCOPED_UI_STATE_ROOT / change_set_id / "docs/use-cases" / uc_id / "event-storming.md"
    if output.exists():
        output.unlink()
    _invalidate_scoped_ddd_architecture(root, change_set_id, uc_id, state=state)
    session_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _invalidate_scoped_ddd_architecture(
    root: Path, change_set_id: str, uc_id: str, *, state: dict[str, Any] | None = None
) -> None:
    session_path = root / SCOPED_UI_STATE_ROOT / change_set_id / "harvest-session.json"
    state = state or _scoped_workflow_state(root, change_set_id, "active")
    ddd_state = (state or {}).get("ddd_architecture")
    if not isinstance(ddd_state, dict) or uc_id not in ddd_state.get("items", {}):
        return
    item = ddd_state["items"][uc_id]
    for step in item.get("steps", {}).values():
        step.update({"status": "stale", "current_question": None, "error": ""})
    item["status"] = "stale"
    ddd_state["complete"] = False
    ddd_state["status"] = "pending"
    ddd_state["current_uc"] = uc_id
    ddd_state["current_step"] = "entity_vo"
    ddd_state["completed_count"] = sum(
        1
        for candidate in ddd_state["items"].values()
        for step in candidate.get("steps", {}).values()
        if step.get("status") == "complete"
    )
    output = root / SCOPED_UI_STATE_ROOT / change_set_id / "docs/use-cases" / uc_id / "ddd-design.md"
    if output.exists():
        output.unlink()
    if state is not None and session_path.exists():
        session_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _project_workflow_stages(
    stages: list[dict[str, str]],
    workflow_state: dict[str, Any] | None,
    run_state: RunState | None = None,
) -> list[dict[str, Any]]:
    if run_state and run_state.artifact_states:
        runtime_rows = runtime_stage_projection(run_state)
        drift_by_stage = {
            drift.stage: drift
            for drift in reconcile_procedure_stage_rows(
                run_state, tuple(dict(stage) for stage in stages)
            )
        }
        projected: list[dict[str, Any]] = []
        for stage in stages:
            row: dict[str, Any] = dict(stage)
            runtime = runtime_rows.get(stage["id"])
            if runtime is not None:
                row["status"] = runtime["status"]
                row["notes"] = runtime["notes"]
                row["source"] = "run_state"
            else:
                row["source"] = "changeset"
            drift = drift_by_stage.get(stage["id"])
            if drift is not None:
                row["drift"] = {
                    "runtime_status": drift.runtime_status,
                    "table_status": drift.table_status,
                    "reason": drift.reason,
                }
            projected.append(row)
        return projected

    if not workflow_state:
        return stages
    completed = set()
    if workflow_state.get("requirements_gate_passed"):
        completed.add("requirements-definition")
        completed.add("ubiquitous-language-definition")
    if workflow_state.get("use_cases_ready"):
        completed.add("use-case-definition")
    if (workflow_state.get("event_storming") or {}).get("complete"):
        completed.add("event-storming")
    if (workflow_state.get("ddd_architecture") or {}).get("complete"):
        completed.add("ddd-architecture-definition")
    for stage in stages:
        if stage["id"] in completed:
            stage["status"] = "verified"
            stage["notes"] = "completed in dashboard workflow"
            stage["source"] = "dashboard_workflow"
    return stages


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
    elif kind == "technical-decisions" and len(parts) == 3:
        uc_id = parts[2]
        state = _scoped_workflow_state(root, change_set_id, "active") or {}
        declared = any(
            item.work_item_type is WorkItemType.USE_CASE and item.work_item_id == uc_id
            for item in change_set.ordered_work_items()
        )
        designed = uc_id in (state.get("ddd_architecture") or {}).get("uc_ids", [])
        if not declared and not designed:
            raise DashboardDocumentNotFound("Use case is not part of the active ChangeSet.")
        path = root / "docs/use-cases" / uc_id / "technical-decisions.md"
        label = f"{uc_id} Technical Decisions"
    elif kind == "generated-use-case" and len(parts) == 3:
        uc_id = parts[2]
        state = _scoped_workflow_state(root, change_set_id, "active")
        if (
            not re.fullmatch(r"UC-\d+", uc_id)
            or not state
            or not state.get("use_cases_ready")
        ):
            raise DashboardDocumentNotFound("Use case is not part of completed UI workflow.")
        path = root / SCOPED_UI_STATE_ROOT / change_set_id / "docs/use-cases" / uc_id / "use-case.md"
        label = f"{uc_id} Use Case"
    elif kind == "event-storming" and len(parts) == 3:
        uc_id = parts[2]
        state = _scoped_workflow_state(root, change_set_id, "active") or {}
        item = (state.get("event_storming") or {}).get("items", {}).get(uc_id, {})
        if not re.fullmatch(r"UC-\d+", uc_id) or item.get("status") != "complete":
            raise DashboardDocumentNotFound("Event storming is not complete for this use case.")
        path = root / SCOPED_UI_STATE_ROOT / change_set_id / "docs/use-cases" / uc_id / "event-storming.md"
        label = f"{uc_id} Event Storming"
    elif kind == "ddd-design" and len(parts) == 3:
        uc_id = parts[2]
        state = _scoped_workflow_state(root, change_set_id, "active") or {}
        item = (state.get("ddd_architecture") or {}).get("items", {}).get(uc_id, {})
        if not re.fullmatch(r"UC-\d+", uc_id) or not any(
            step.get("status") == "complete" for step in item.get("steps", {}).values()
        ):
            raise DashboardDocumentNotFound("DDD architecture has no completed substep for this use case.")
        path = root / SCOPED_UI_STATE_ROOT / change_set_id / "docs/use-cases" / uc_id / "ddd-design.md"
        label = f"{uc_id} DDD Design"
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
        "metadata": parse_front_matter(content),
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
    elif document["kind"] == "event-storming":
        required_groups = (
            ("### [Flow:",),
            ("🟦",),
            ("🟧",),
            ("🟪",),
        )
    elif document["kind"] == "ddd-design":
        required_groups = (
            ("## Impact Assessment",),
            ("## Entity / Value Objects",),
            ("Evidence",),
        )
    elif document["kind"] == "technical-decisions":
        required_groups = (
            ("# Technical Decisions",),
            ("Approval Status",),
            ("## 2. Input Documents",),
            ("Pending Decisions",),
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
    if document["kind"] == "ddd-design" and not _ddd_entity_vo_has_typed_definition(content):
        raise DashboardDocumentValidationError(
            "DDD Entity / Value Objects must define typed entity or value-object attributes."
        )
    if document["kind"] == "ddd-design" and not _ddd_aggregates_have_real_names_when_present(content):
        raise DashboardDocumentValidationError("DDD Aggregates must define explicit aggregate names.")


def _ddd_entity_vo_has_typed_definition(content: str) -> bool:
    section = _section_text(content, "## Entity / Value Objects")
    typed_columns = {
        "attributes / vos",
        "core attributes",
        "constructor / validation rules",
        "proposed definition",
        "proposed identity / state",
    }
    typed_indexes: list[int] = []
    for line in section.splitlines():
        if not line.startswith("|") or "---" in line:
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        lowered = [cell.lower() for cell in cells]
        if set(lowered) & typed_columns:
            typed_indexes = [index for index, cell in enumerate(lowered) if cell in typed_columns]
            continue
        candidates = [cells[index] for index in typed_indexes if index < len(cells)] if typed_indexes else cells[1:2]
        if any(_looks_like_typed_ddd_value(cell) for cell in candidates):
            return True
    return False


def _looks_like_typed_ddd_value(value: str) -> bool:
    if re.search(r"`?[a-z][A-Za-z0-9_]*`?\s*:\s*`?[A-Z][A-Za-z0-9_<>,\[\]?]*`?", value):
        return True
    return bool(re.search(r"`?[A-Z][A-Za-z0-9_<>]*(?:RelativePath|Path|Id|ID|String|Content|Name|List)?`?\s+[a-z][A-Za-z0-9_]*", value))


def _ddd_aggregates_have_real_names_when_present(content: str) -> bool:
    section = _section_text(content, "## Aggregates")
    if not section:
        return True
    aggregate_index: int | None = None
    for line in section.splitlines():
        if not line.startswith("|") or "---" in line:
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        lowered = [cell.lower() for cell in cells]
        if "aggregate" in lowered and ("aggregate root" in lowered or "atomic invariant" in lowered or "members" in lowered):
            aggregate_index = lowered.index("aggregate")
            continue
        if aggregate_index is None or aggregate_index >= len(cells):
            continue
        if not any(cells):
            continue
        name = cells[aggregate_index].strip("` ")
        if not name or name.lower() == "aggregate":
            return False
    return True


def _stale_stage_ids(kind: str) -> tuple[str, ...]:
    if kind == "requirements":
        return (
            "ubiquitous-language-definition",
            "use-case-definition",
            "event-storming",
            "ddd-architecture-definition",
            "technical-decisions",
            "plan-writing",
            "implementation",
        )
    if kind == "event-storming":
        return (
            "ddd-architecture-definition",
            "technical-decisions",
            "plan-writing",
            "implementation",
        )
    if kind == "ddd-design":
        return ("technical-decisions", "plan-writing", "implementation")
    return (
        "event-storming",
        "ddd-architecture-definition",
        "technical-decisions",
        "plan-writing",
        "implementation",
    )


def _parse_procedure_stages(text: str) -> list[dict[str, str]]:
    return [dict(row) for row in parse_procedure_stage_rows(text)]


def _parse_event_storming(text: str) -> dict[str, Any]:
    flows: list[dict[str, Any]] = []
    matches = list(re.finditer(r"^### \[Flow: ([^\]]+)\]\s*$", text, re.MULTILINE))
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        block = text[match.end():end].split("---", 1)[0]
        source_name = match.group(1).strip()
        kind = _event_flow_kind(source_name)
        notes: list[dict[str, str]] = []
        for line in block.splitlines():
            value = line.strip().removeprefix("→").strip()
            note_type = _sticky_type(value)
            if note_type:
                notes.append({"type": note_type, "text": _sticky_text(value[2:])})
        if notes:
            ordinal = sum(1 for flow in flows if flow["kind"] == kind) + 1
            label = "Main Flow" if kind == "main" else f"Exception Flow {ordinal}"
            flows.append(
                {"name": label, "source_name": source_name, "kind": kind, "notes": notes}
            )
    supporting: list[dict[str, str]] = []
    domain_elements: list[dict[str, str]] = []
    systems: set[str] = set()
    externals: set[str] = set()
    in_domain_elements = False
    in_external_systems = False
    for line in text.splitlines():
        if line.startswith("## 5."):
            in_domain_elements = True
        elif in_domain_elements and line.startswith("## "):
            in_domain_elements = False
        if line.startswith("## 6."):
            in_external_systems = True
        elif in_external_systems and line.startswith("## "):
            in_external_systems = False
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) > 1 and cells[0] in ("⬛", "🟩"):
            note_type = "system" if cells[0] == "⬛" else "external_system"
            supporting.append({"type": note_type, "text": _sticky_text(cells[1])})
        if in_domain_elements and len(cells) >= 5 and cells[0] in ("🟦", "🟧", "🟪"):
            domain_elements.append(
                {
                    "type": _sticky_type(cells[0]) or "",
                    "text": _sticky_text(cells[1]),
                    "trigger": _sticky_text(cells[2]),
                    "result": _sticky_text(cells[3]),
                }
            )
            if cells[4] not in ("", "없음"):
                systems.add(_sticky_text(cells[4]))
        if (
            in_external_systems
            and len(cells) >= 2
            and cells[0] not in ("시스템", "---", "없음", "")
            and not set(cells[0]) <= {"-"}
        ):
            externals.add(_sticky_text(cells[0]))
    _apply_domain_element_labels(flows, domain_elements)
    supporting.extend({"type": "system", "text": value} for value in sorted(systems))
    supporting.extend({"type": "external_system", "text": value} for value in sorted(externals))
    return {"flows": flows, "supporting_notes": supporting}


def _event_flow_kind(source_name: str) -> str:
    normalized = source_name.lower()
    main_markers = ("main", "basic", "normal", "happy", "success", "primary", "default")
    if any(marker in normalized for marker in main_markers):
        return "main"
    if any(marker in source_name for marker in ("기본", "정상", "성공", "주요", "표준")):
        return "main"
    return "exception"


def _scoped_event_storming_board(
    root: Path,
    change_set_id: str,
    lifecycle: str,
    workflow_state: dict[str, Any] | None,
) -> dict[str, Any]:
    if lifecycle != "active" or not workflow_state:
        return {"slices": []}
    state = workflow_state.get("event_storming") or {}
    slices: list[dict[str, Any]] = []
    for uc_id in state.get("uc_ids", []):
        if state.get("items", {}).get(uc_id, {}).get("status") != "complete":
            continue
        path = root / SCOPED_UI_STATE_ROOT / change_set_id / "docs/use-cases" / uc_id / "event-storming.md"
        if not path.exists():
            continue
        board = _parse_event_storming(path.read_text(encoding="utf-8"))
        slices.append({"uc_id": uc_id, **board})
    return {"slices": slices}


def _sticky_type(value: str) -> str | None:
    return {
        "🟦": "command",
        "🟧": "event",
        "🟪": "policy",
        "⬛": "system",
        "🟩": "external_system",
    }.get(value[:1])


def _sticky_text(value: str) -> str:
    return re.sub(r"`([^`]*)`", r"\1", value.strip())


def _apply_domain_element_labels(
    flows: list[dict[str, Any]], domain_elements: list[dict[str, str]]
) -> None:
    for flow in flows:
        original = [dict(note) for note in flow["notes"]]
        for index, note in enumerate(original):
            previous = original[index - 1]["text"] if index else ""
            following = original[index + 1]["text"] if index + 1 < len(original) else ""
            candidates = [
                element for element in domain_elements if element["type"] == note["type"]
            ]
            best = max(
                candidates,
                key=lambda element: _domain_element_score(element, note["text"], previous, following),
                default=None,
            )
            if best and _domain_element_score(best, note["text"], previous, following) > 0:
                flow["notes"][index]["text"] = best["text"]


def _domain_element_score(
    element: dict[str, str], text: str, previous: str, following: str
) -> int:
    return (
        (4 if element["text"] == text else 0)
        + (2 if previous and element["trigger"] == previous else 0)
        + (2 if following and element["result"] == following else 0)
    )


DDD_SECTION_HEADINGS = (
    ("entity_vo", "## Entity / Value Objects"),
    ("behaviors", "## Behaviors"),
    ("application_flow", "## Application Flow"),
    ("aggregates", "## Aggregates"),
    ("bounded_contexts", "## Bounded Contexts"),
)


def _scoped_ddd_architecture_board(
    root: Path,
    change_set_id: str,
    lifecycle: str,
    workflow_state: dict[str, Any] | None,
) -> dict[str, Any]:
    if lifecycle != "active" or not workflow_state:
        return {"slices": []}
    state = workflow_state.get("ddd_architecture") or {}
    slices: list[dict[str, Any]] = []
    for uc_id in state.get("uc_ids", []):
        item = state.get("items", {}).get(uc_id, {})
        completed = [
            step_id for step_id, _heading in DDD_SECTION_HEADINGS
            if item.get("steps", {}).get(step_id, {}).get("status") == "complete"
        ]
        path = root / SCOPED_UI_STATE_ROOT / change_set_id / "docs/use-cases" / uc_id / "ddd-design.md"
        if completed and path.exists():
            slices.append({"uc_id": uc_id, "completed_steps": completed, **_parse_ddd_design(path.read_text(encoding="utf-8"))})
    return {"slices": slices}


def _parse_ddd_design(text: str) -> dict[str, Any]:
    impact = _ddd_table_rows(text, "## Impact Assessment")
    return {
        "impact": impact,
        "entity_vo": _normalize_ddd_entity_vo_rows(_ddd_table_rows(text, "## Entity / Value Objects"), impact),
        "behaviors": _ddd_table_rows(text, "## Behaviors"),
        "application_flow": _ddd_table_rows(text, "## Application Flow"),
        "aggregates": _ddd_table_rows(text, "## Aggregates"),
        "bounded_contexts": _ddd_table_rows(text, "## Bounded Contexts"),
    }


def _normalize_ddd_entity_vo_rows(
    rows: list[dict[str, str]], impact_rows: list[dict[str, str]] | None = None
) -> list[dict[str, Any]]:
    impact_kinds = {
        row.get("Element") or row.get("Model", ""): row.get("Element Type") or row.get("Kind") or row.get("Type", "")
        for row in impact_rows or []
        if row.get("Element") or row.get("Model")
    }
    normalized: list[dict[str, Any]] = []
    for row in rows:
        if "Entity" in row and "Attributes / VOs" in row:
            normalized.append({**row, "Model Type": row.get("Model Type") or impact_kinds.get(row.get("Entity", ""), "")})
            continue
        model = row.get("Model", "")
        if not model:
            normalized.append(row)
            continue
        normalized.append(
            {
                "Entity": model,
                "Attributes / VOs": row.get("Core attributes") or row.get("Proposed Identity / State", ""),
                "Model Type": row.get("Kind") or row.get("Type") or impact_kinds.get(model, ""),
                "Status": row.get("Classification") or row.get("Kind", ""),
                "Previous Definition": "",
                "Proposed Definition": row.get("Proposed Identity / State") or row.get("Core attributes", ""),
                "Evidence": row.get("Evidence") or row.get("Why new", ""),
            }
        )
    vo_names = {
        _sticky_text(row.get("Entity", "")).strip()
        for row in normalized
        if _ddd_model_kind_label(row.get("Model Type") or row.get("Kind") or row.get("Type")) == "vo"
    }
    for row in normalized:
        vo_names.update(definition["name"] for definition in _ddd_inline_vo_definitions(row.get("Attributes / VOs", "")))
    for row in normalized:
        model_name = _sticky_text(row.get("Entity", "")).strip()
        model_type = _ddd_model_kind_label(row.get("Model Type") or row.get("Kind") or row.get("Type"))
        properties = _ddd_model_properties(row.get("Attributes / VOs", ""), model_name=model_name)
        for prop in properties:
            prop["kind"] = "vo" if prop["type"] in vo_names and prop["type"] != model_name else "attribute"
        row["Properties"] = properties
        if model_type != "vo":
            references = [prop for prop in properties if prop.get("kind") == "vo"]
            referenced_names = {prop["type"] for prop in references}
            for definition in _ddd_inline_vo_definitions(row.get("Attributes / VOs", "")):
                if definition["name"] not in referenced_names and definition["name"] != model_name:
                    references.append(
                        {
                            "name": definition["name"],
                            "type": definition["name"],
                            "display": definition["name"],
                            "kind": "vo",
                        }
                    )
            row["VO References"] = references
        else:
            row["VO References"] = []
    return normalized


def _ddd_model_kind_label(kind: str | None) -> str:
    normalized = str(kind or "").lower()
    if "value object" in normalized or normalized == "vo":
        return "vo"
    if "entity" in normalized:
        return "entity"
    return ""


def _ddd_inline_vo_definitions(attributes: str) -> list[dict[str, Any]]:
    definitions: list[dict[str, Any]] = []
    for part in _split_ddd_attribute_parts(attributes):
        match = re.match(r"^([A-Z][A-Za-z0-9_]*)\s*\{([^}]*)\}", part)
        if not match:
            continue
        name = match.group(1)
        fields = _ddd_model_properties(match.group(2), model_name=name)
        definitions.append({"name": name, "properties": fields})
    return definitions


def _ddd_model_properties(attributes: str, *, model_name: str = "") -> list[dict[str, str]]:
    properties: list[dict[str, str]] = []
    for part in _split_ddd_attribute_parts(attributes):
        inline_vo = re.match(r"^([A-Z][A-Za-z0-9_]*)\s*\{([^}]*)\}", part)
        if inline_vo:
            if inline_vo.group(1) != model_name:
                continue
            properties.extend(_ddd_model_properties(inline_vo.group(2), model_name=model_name))
            continue
        name_first = re.match(r"^([A-Za-z_][A-Za-z0-9_?]*)\s*:\s*([^()]+?)(?:\s*\(|$)", part)
        if name_first:
            name, type_name = name_first.group(1), _clean_ddd_type(name_first.group(2))
            if not type_name:
                continue
            properties.append({"name": name, "type": type_name, "display": f"{type_name} {name}"})
            continue
        type_first = re.match(r"^([A-Z][A-Za-z0-9_<>,\[\]?]*|[a-z][A-Za-z0-9_]*<[^>]+>)\s+([a-z][A-Za-z0-9_?]*)(?:\s*\(|$)", part)
        if type_first:
            type_name, name = _clean_ddd_type(type_first.group(1)), type_first.group(2)
            if not type_name:
                continue
            properties.append({"name": name, "type": type_name, "display": f"{type_name} {name}"})
    return properties


def _clean_ddd_type(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().strip("`").strip()).rstrip(":,;")


def _split_ddd_attribute_parts(attributes: str) -> list[str]:
    text = _sticky_text(attributes).replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
    parts: list[str] = []
    current: list[str] = []
    brace_depth = 0
    paren_depth = 0
    for char in text:
        if char == "{":
            brace_depth += 1
        elif char == "}":
            brace_depth = max(0, brace_depth - 1)
        elif char == "(":
            paren_depth += 1
        elif char == ")":
            paren_depth = max(0, paren_depth - 1)
        if char in ",;\n" and brace_depth == 0 and paren_depth == 0:
            part = "".join(current).strip()
            if part:
                parts.append(part)
            current = []
            continue
        current.append(char)
    part = "".join(current).strip()
    if part:
        parts.append(part)
    return parts


def _ddd_table_rows(text: str, heading: str) -> list[dict[str, str]]:
    section = _section_text(text, heading)
    rows = [line for line in section.splitlines() if line.strip().startswith("|")]
    if len(rows) < 3:
        return []
    headers = [_clean_cell(cell) for cell in rows[0].strip().strip("|").split("|")]
    parsed: list[dict[str, str]] = []
    for line in rows[2:]:
        cells = [_clean_cell(cell) for cell in line.strip().strip("|").split("|")]
        if len(cells) == len(headers):
            if not any(cells):
                continue
            parsed.append(dict(zip(headers, cells)))
    return parsed


def _clean_cell(value: str) -> str:
    return _sticky_text(value).replace("~~", "").strip()


def _stale_ddd_steps_after_edit(
    root: Path, change_set_id: str, uc_id: str, before: str, after: str
) -> None:
    state = _scoped_workflow_state(root, change_set_id, "active")
    ddd_state = (state or {}).get("ddd_architecture")
    if not isinstance(ddd_state, dict):
        return
    item = ddd_state.get("items", {}).get(uc_id)
    if not isinstance(item, dict):
        return
    changed_index = next(
        (
            index for index, (_step_id, heading) in enumerate(DDD_SECTION_HEADINGS)
            if _section_text(before, heading) != _section_text(after, heading)
        ),
        None,
    )
    if changed_index is None:
        return
    staled = False
    for step_id, _heading in DDD_SECTION_HEADINGS[changed_index + 1:]:
        step = item.get("steps", {}).get(step_id, {})
        if step.get("status") == "complete":
            step["status"] = "stale"
            staled = True
    if not staled:
        return
    item["status"] = "pending"
    ddd_state["complete"] = False
    ddd_state["status"] = "pending"
    ddd_state["current_uc"] = uc_id
    ddd_state["current_step"] = DDD_SECTION_HEADINGS[min(changed_index + 1, len(DDD_SECTION_HEADINGS) - 1)][0]
    ddd_state["completed_count"] = sum(
        1
        for candidate in ddd_state["items"].values()
        for step in candidate.get("steps", {}).values()
        if step.get("status") == "complete"
    )
    session_path = root / SCOPED_UI_STATE_ROOT / change_set_id / "harvest-session.json"
    session_path.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


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


def _load_run_state(root: Path, run_id: str) -> RunState | None:
    try:
        return RunStateStore(root).load(run_id)
    except (FileNotFoundError, ValueError, KeyError, json.JSONDecodeError):
        return None


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
