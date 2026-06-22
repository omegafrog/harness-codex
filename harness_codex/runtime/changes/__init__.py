"""ChangeSet parsing and affected use-case resolution."""

from pathlib import Path

from harness_codex.runtime.changes.models import (
    AffectedMaintenanceItem,
    AffectedUseCase,
    AffectedWorkItem,
    ChangeSet,
    ChangeSetDocument,
    GoalApproval,
    PlanningBlocked,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.changes.design_bridge import (
    DesignBridgeError,
    DesignBridgeResult,
    DesignUseCase,
    create_changeset_from_design,
)
from harness_codex.runtime.changes.resolver import (
    ChangeSetResolver,
    NoActiveChangeSetsError,
)
from harness_codex.runtime.changes.work_item_documents import missing_required_documents


def _missing_maintenance_documents(repo_root: Path, slice_path: Path) -> tuple[Path, ...]:
    """Keep the legacy maintenance preflight helper aligned with typed contracts."""

    return missing_required_documents(
        repo_root,
        AffectedWorkItem(
            work_item_id=slice_path.name,
            work_item_type=WorkItemType.MAINTENANCE,
            name="",
            impact_type="",
            slice_path=slice_path,
        ),
    )


# The planner-alignment test and external extensions historically import this helper
# from ``resolver``.  Keep that public compatibility surface while delegating the
# source of truth to the typed work-item document contract.
import harness_codex.runtime.changes.resolver as _resolver

_resolver._missing_maintenance_documents = _missing_maintenance_documents


__all__ = [
    "AffectedMaintenanceItem",
    "AffectedUseCase",
    "AffectedWorkItem",
    "ChangeSet",
    "ChangeSetDocument",
    "ChangeSetResolver",
    "DesignBridgeError",
    "DesignBridgeResult",
    "DesignUseCase",
    "GoalApproval",
    "NoActiveChangeSetsError",
    "PlanningBlocked",
    "PlanningInputScope",
    "WorkItemType",
    "create_changeset_from_design",
    "parse_changeset_markdown",
]
