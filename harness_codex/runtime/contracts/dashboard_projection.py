"""Document-node and contract-edge projection for harness dashboard clients."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from harness_codex.runtime.changes.models import (
    AffectedWorkItem,
    ChangeSet,
    GoalApproval,
    WorkItemType,
)
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.contracts.registry import DocumentContractRegistry


SCOPED_UI_STATE_ROOT = Path(".harness/ui/change-sets")
APPROVED_STATUS = "approved"


@dataclass(frozen=True)
class DocumentSpec:
    path: Path
    doc_type: str
    approval_required: bool = False


@dataclass(frozen=True)
class ContractSpec:
    source: str
    target: str
    contract_id: str


@dataclass(frozen=True)
class DocumentContractDashboardRow:
    """Small dashboard-safe row for one document contract."""

    doc_type: str
    path_pattern: str
    owner_stage: str
    dashboard_fields: tuple[str, ...]
    stales_downstream: tuple[str, ...]


def document_contract_dashboard_rows(
    registry: DocumentContractRegistry,
) -> tuple[DocumentContractDashboardRow, ...]:
    """Project registry contracts into deterministic dashboard rows."""

    return tuple(
        DocumentContractDashboardRow(
            doc_type=contract.doc_type,
            path_pattern=contract.path_pattern,
            owner_stage=contract.owner_stage,
            dashboard_fields=contract.dashboard_fields,
            stales_downstream=contract.stales_downstream,
        )
        for contract in registry.contracts
    )


def contract_dashboard_projection(
    repo_root: Path | str,
    *,
    change_set_id: str = "",
) -> dict[str, Any]:
    """Project ChangeSet work-item documents into nodes and contract edges."""

    root = Path(repo_root)
    change_sets = [
        _project_change_set(root, change_set, lifecycle)
        for change_set, lifecycle in _load_change_sets(root, change_set_id=change_set_id)
    ]
    return {"change_sets": change_sets}


def contract_dashboard_projection_json(
    repo_root: Path | str,
    *,
    change_set_id: str = "",
) -> str:
    """Return deterministic JSON for contract dashboard clients."""

    return (
        json.dumps(
            contract_dashboard_projection(repo_root, change_set_id=change_set_id),
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )


def _load_change_sets(
    root: Path,
    *,
    change_set_id: str,
) -> tuple[tuple[ChangeSet, str], ...]:
    loaded: list[tuple[ChangeSet, str]] = []
    for lifecycle in ("active", "completed"):
        directory = root / "docs/changes" / lifecycle
        for path in sorted(directory.glob("*.md")):
            if change_set_id and path.stem != change_set_id:
                continue
            relative_path = path.relative_to(root)
            change_set = parse_changeset_markdown(
                path.read_text(encoding="utf-8"),
                path=relative_path,
            )
            loaded.append((change_set, lifecycle))
    return tuple(loaded)


def _project_change_set(
    root: Path,
    change_set: ChangeSet,
    lifecycle: str,
) -> dict[str, Any]:
    work_items = [
        _project_work_item(root, change_set, work_item)
        for work_item in change_set.ordered_work_items()
    ]
    blockers = [
        blocker
        for item in work_items
        for blocker in (
            *(
                document_blocker
                for document in item["documents"]
                for document_blocker in document["blockers"]
            ),
            *(
                edge["blocker"]
                for edge in item["contract_edges"]
                if edge["blocker"]
            ),
        )
    ]
    first_blocked = next(
        (
            item
            for item in work_items
            if item["status"] != "ready"
        ),
        None,
    )
    return {
        "id": change_set.change_set_id,
        "status": change_set.status or lifecycle,
        "current_gate": first_blocked["current_stage"] if first_blocked else "complete",
        "blocker_count": len(blockers),
        "work_items": work_items,
    }


def _project_work_item(
    root: Path,
    change_set: ChangeSet,
    work_item: AffectedWorkItem,
) -> dict[str, Any]:
    document_specs = _document_specs(work_item)
    contract_specs = _contract_specs(work_item)
    approval_by_path = _approval_by_path(change_set.goal_approvals)
    documents = {
        str(spec.path): _project_document(
            root,
            change_set.change_set_id,
            spec,
            approval_by_path.get(spec.path),
        )
        for spec in document_specs
    }
    _mark_stale_documents(root, documents, contract_specs)
    edges = [_project_edge(root, documents, edge) for edge in contract_specs]
    document_list = [documents[str(spec.path)] for spec in document_specs]
    first_blocked_document = next(
        (document for document in document_list if document["status"] != "ready"),
        None,
    )
    first_failed_edge = next((edge for edge in edges if edge["status"] != "pass"), None)
    blocker_count = sum(len(document["blockers"]) for document in document_list) + sum(
        1 for edge in edges if edge["blocker"]
    )
    current_stage = (
        first_blocked_document["type"]
        if first_blocked_document
        else first_failed_edge["contract"]
        if first_failed_edge
        else "complete"
    )
    return {
        "id": work_item.work_item_id,
        "type": work_item.work_item_type.value,
        "status": "blocked" if blocker_count else "ready",
        "current_stage": current_stage,
        "documents": document_list,
        "contract_edges": edges,
    }


def _document_specs(work_item: AffectedWorkItem) -> tuple[DocumentSpec, ...]:
    slice_path = work_item.slice_path
    plan_path = Path("docs/plans/active") / work_item.work_item_id / "plan.md"
    if work_item.work_item_type == WorkItemType.MAINTENANCE:
        return (
            DocumentSpec(slice_path / "change-intent.md", "change_intent"),
            DocumentSpec(slice_path / "affected-files.md", "affected_files"),
            DocumentSpec(slice_path / "technical-decisions.md", "technical_decisions", True),
            DocumentSpec(slice_path / "verification-goal.md", "verification_goal", True),
            DocumentSpec(plan_path, "plan"),
        )
    return (
        DocumentSpec(slice_path / "use-case.md", "use_case"),
        DocumentSpec(slice_path / "e2e-goal.md", "e2e_goal"),
        DocumentSpec(slice_path / "event-storming.md", "event_storming"),
        DocumentSpec(slice_path / "ddd-design.md", "ddd_design"),
        DocumentSpec(slice_path / "technical-decisions.md", "technical_decisions", True),
        DocumentSpec(plan_path, "plan"),
    )


def _contract_specs(work_item: AffectedWorkItem) -> tuple[ContractSpec, ...]:
    slice_path = work_item.slice_path
    plan_path = Path("docs/plans/active") / work_item.work_item_id / "plan.md"
    if work_item.work_item_type == WorkItemType.MAINTENANCE:
        return (
            ContractSpec(
                str(slice_path / "change-intent.md"),
                str(slice_path / "affected-files.md"),
                "change_intent_affected_file_scope",
            ),
            ContractSpec(
                str(slice_path / "affected-files.md"),
                str(slice_path / "verification-goal.md"),
                "affected_file_verification_scope",
            ),
            ContractSpec(
                str(slice_path / "technical-decisions.md"),
                str(plan_path),
                "technical_decision_plan_coverage",
            ),
            ContractSpec(
                str(slice_path / "verification-goal.md"),
                str(plan_path),
                "verification_goal_plan_coverage",
            ),
        )
    return (
        ContractSpec(
            str(slice_path / "use-case.md"),
            str(slice_path / "e2e-goal.md"),
            "use_case_e2e_alignment",
        ),
        ContractSpec(
            str(slice_path / "e2e-goal.md"),
            str(slice_path / "event-storming.md"),
            "e2e_event_storming_traceability",
        ),
        ContractSpec(
            str(slice_path / "event-storming.md"),
            str(slice_path / "ddd-design.md"),
            "event_storming_ddd_design_traceability",
        ),
        ContractSpec(
            str(slice_path / "ddd-design.md"),
            str(slice_path / "technical-decisions.md"),
            "ddd_design_technical_decision_coverage",
        ),
        ContractSpec(
            str(slice_path / "technical-decisions.md"),
            str(plan_path),
            "technical_decision_plan_coverage",
        ),
    )


def _project_document(
    root: Path,
    change_set_id: str,
    spec: DocumentSpec,
    goal_approval: GoalApproval | None,
) -> dict[str, Any]:
    absolute_path = root / spec.path
    exists = absolute_path.exists()
    text = absolute_path.read_text(encoding="utf-8") if exists else ""
    found_approval, document_approval = _approval_status_from_markdown(text)
    approval_status = goal_approval.approval_status if goal_approval else document_approval
    blockers: list[str] = []

    if not exists:
        blockers.append(f"Missing document: {spec.path}")
    elif goal_approval and approval_status.lower() != APPROVED_STATUS:
        blockers.append(
            f"Approval pending for {spec.path}: status={approval_status or '<blank>'}"
        )
    elif spec.approval_required and (
        not found_approval or approval_status.lower() != APPROVED_STATUS
    ):
        status = approval_status or ("<missing>" if not found_approval else "<blank>")
        blockers.append(f"Approval required for {spec.path}: status={status}")

    if exists and spec.doc_type == "technical_decisions":
        pending_items = _pending_decision_items_from_markdown(text)
        if pending_items:
            blockers.append(
                f"Pending technical decisions in {spec.path}: "
                + "; ".join(pending_items[:3])
            )

    dirty = _is_dirty(root, change_set_id, spec.path)
    status = "missing" if not exists else "blocked" if blockers else "ready"
    return {
        "path": str(spec.path),
        "type": spec.doc_type,
        "status": status,
        "checksum": _checksum(absolute_path) if exists else "",
        "dirty": dirty,
        "stale": False,
        "accepted": exists and not dirty and not blockers,
        "approval_status": approval_status,
        "blockers": blockers,
    }


def _mark_stale_documents(
    root: Path,
    documents: dict[str, dict[str, Any]],
    contract_specs: tuple[ContractSpec, ...],
) -> None:
    for edge in contract_specs:
        source = documents.get(edge.source)
        target = documents.get(edge.target)
        if source is None or target is None:
            continue
        if source["status"] == "missing" or target["status"] == "missing":
            continue
        source_path = root / source["path"]
        target_path = root / target["path"]
        if target_path.stat().st_mtime < source_path.stat().st_mtime:
            target["stale"] = True
            target["status"] = "stale"
            target["accepted"] = False
            target["blockers"].append(
                f"Stale document: {target['path']} is older than {source['path']}"
            )


def _project_edge(
    root: Path,
    documents: dict[str, dict[str, Any]],
    edge: ContractSpec,
) -> dict[str, str]:
    source = documents[edge.source]
    target = documents[edge.target]
    blocker = ""
    if source["status"] == "missing":
        blocker = f"Source document missing: {source['path']}"
    elif target["status"] == "missing":
        blocker = f"Target document missing: {target['path']}"
    elif target["stale"]:
        blocker = f"Target document stale: {target['path']}"
    elif target["blockers"]:
        blocker = target["blockers"][0]
    elif edge.contract_id == "technical_decision_plan_coverage":
        blocker = _technical_decision_plan_blocker(root, Path(edge.source), Path(edge.target))

    return {
        "from": source["path"],
        "to": target["path"],
        "contract": edge.contract_id,
        "status": "fail" if blocker else "pass",
        "blocker": blocker,
    }


def _technical_decision_plan_blocker(
    root: Path,
    technical_path: Path,
    plan_path: Path,
) -> str:
    technical_absolute = root / technical_path
    plan_absolute = root / plan_path
    if not technical_absolute.exists() or not plan_absolute.exists():
        return ""

    decision_terms = _approved_decision_terms(
        technical_absolute.read_text(encoding="utf-8")
    )
    if not decision_terms:
        return ""

    plan_text = _normalize_text(plan_absolute.read_text(encoding="utf-8"))
    missing = [term for term in decision_terms if term not in plan_text]
    if not missing:
        return ""
    return f"Approved technical decision has no plan coverage: {missing[0]}"


def _approved_decision_terms(text: str) -> tuple[str, ...]:
    section = _markdown_section(text, "Approved Decisions", "Decisions")
    terms: list[str] = []
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        item = stripped.removeprefix("-").strip()
        if not item or item.lower() in {"none", "n/a"}:
            continue
        code_match = re.search(r"`([^`]+)`", item)
        source = code_match.group(1) if code_match else item
        words = re.findall(r"[A-Za-z0-9_-]+", source.lower())
        if words:
            terms.append(words[0])
    return tuple(dict.fromkeys(terms))


def _approval_by_path(
    approvals: tuple[GoalApproval, ...],
) -> dict[Path, GoalApproval]:
    return {approval.path: approval for approval in approvals}


def _approval_status_from_markdown(text: str) -> tuple[bool, str]:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|"):
            continue
        cells = [cell.strip().strip("`") for cell in stripped.strip("|").split("|")]
        if len(cells) >= 2 and cells[0] in {"Approval Status", "승인 상태"}:
            return True, cells[1]
    return False, ""


def _pending_decision_items_from_markdown(text: str) -> tuple[str, ...]:
    section = _markdown_section(text, "Pending Decisions")
    pending: list[str] = []
    for line in section.splitlines():
        stripped = line.strip()
        if not stripped.startswith("-"):
            continue
        item = stripped.removeprefix("-").strip()
        if item and item.lower() not in {"none", "n/a"}:
            pending.append(item)
    return tuple(pending)


def _markdown_section(text: str, *titles: str) -> str:
    normalized_titles = {title.lower() for title in titles}
    lines = text.splitlines()
    capture = False
    captured: list[str] = []
    for line in lines:
        if line.startswith("## "):
            title = line.lstrip("#").strip()
            title = re.sub(r"^\d+\.\s*", "", title).lower()
            if capture:
                break
            capture = title in normalized_titles
            continue
        if capture:
            captured.append(line)
    return "\n".join(captured)


def _is_dirty(root: Path, change_set_id: str, path: Path) -> bool:
    scoped_path = root / SCOPED_UI_STATE_ROOT / change_set_id / path
    repo_path = root / path
    if not scoped_path.exists() or not repo_path.exists():
        return False
    return _checksum(scoped_path) != _checksum(repo_path)


def _checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _normalize_text(text: str) -> str:
    return " ".join(re.findall(r"[A-Za-z0-9_-]+", text.lower()))
