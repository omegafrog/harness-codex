"""Models for ChangeSet based workflow planning."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class WorkItemType(str, Enum):
    """Execution unit type inside one ChangeSet."""

    USE_CASE = "use_case"
    MAINTENANCE = "maintenance"


@dataclass(frozen=True)
class ChangeSetDocument:
    """One document listed in a ChangeSet document delta."""

    path: Path
    change_type: str
    reason: str = ""
    status: str = ""


@dataclass(frozen=True)
class AffectedUseCase:
    """Use case affected by an active ChangeSet."""

    uc_id: str
    name: str
    impact_type: str
    slice_path: Path
    status: str = ""


@dataclass(frozen=True)
class AffectedMaintenanceItem:
    """Maintenance work affected by an active ChangeSet."""

    maintenance_id: str
    name: str
    impact_type: str
    slice_path: Path
    status: str = ""


@dataclass(frozen=True)
class AffectedWorkItem:
    """Ordered generic execution unit resolved from a ChangeSet."""

    work_item_id: str
    work_item_type: WorkItemType
    name: str
    impact_type: str
    slice_path: Path
    status: str = ""


@dataclass(frozen=True)
class ChangeSet:
    """Structured representation of `docs/changes/active/<CHG-ID>.md`."""

    change_set_id: str
    title: str
    path: Path | None = None
    status: str = ""
    related_issue: str = ""
    intent_summary: str = ""
    before_summary: str = ""
    after_summary: str = ""
    changed_documents: tuple[ChangeSetDocument, ...] = ()
    affected_use_cases: tuple[AffectedUseCase, ...] = ()
    affected_maintenance_items: tuple[AffectedMaintenanceItem, ...] = ()
    affected_work_items: tuple[AffectedWorkItem, ...] = ()
    planner_inputs: tuple[Path, ...] = ()
    included_scope: tuple[str, ...] = ()
    excluded_scope: tuple[str, ...] = ()
    forbidden_changes: tuple[str, ...] = ()

    def ordered_work_items(self) -> tuple[AffectedWorkItem, ...]:
        """Return ChangeSet work items while keeping legacy UC compatibility."""

        if self.affected_work_items:
            return self.affected_work_items

        use_case_items = tuple(
            AffectedWorkItem(
                work_item_id=use_case.uc_id,
                work_item_type=WorkItemType.USE_CASE,
                name=use_case.name,
                impact_type=use_case.impact_type,
                slice_path=use_case.slice_path,
                status=use_case.status,
            )
            for use_case in self.affected_use_cases
        )
        maintenance_items = tuple(
            AffectedWorkItem(
                work_item_id=item.maintenance_id,
                work_item_type=WorkItemType.MAINTENANCE,
                name=item.name,
                impact_type=item.impact_type,
                slice_path=item.slice_path,
                status=item.status,
            )
            for item in self.affected_maintenance_items
        )
        return use_case_items + maintenance_items


@dataclass(frozen=True)
class PlanningInputScope:
    """Planner/executor inputs resolved for one affected work item."""

    change_set_path: Path
    use_case: AffectedUseCase | None
    planner_inputs: tuple[Path, ...]
    executor_inputs: tuple[Path, ...]
    e2e_goal_path: Path | None
    work_item_id: str = ""
    work_item_type: WorkItemType = WorkItemType.USE_CASE
    plan_path: Path | None = None
    verification_goal_path: Path | None = None
    current_stage: str = "plan"
    blocker: str | None = None
    verification_result: str = ""

    @property
    def display_id(self) -> str:
        return self.work_item_id or (self.use_case.uc_id if self.use_case else "")


@dataclass(frozen=True)
class PlanningBlocked:
    """Result returned when a ChangeSet cannot produce planning scope."""

    change_set_id: str
    reason: str
