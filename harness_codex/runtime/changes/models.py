"""Models for ChangeSet based workflow planning."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


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
    planner_inputs: tuple[Path, ...] = ()
    included_scope: tuple[str, ...] = ()
    excluded_scope: tuple[str, ...] = ()
    forbidden_changes: tuple[str, ...] = ()


@dataclass(frozen=True)
class PlanningInputScope:
    """Planner/executor inputs resolved for one affected use case."""

    change_set_path: Path
    use_case: AffectedUseCase
    planner_inputs: tuple[Path, ...]
    executor_inputs: tuple[Path, ...]
    e2e_goal_path: Path


@dataclass(frozen=True)
class PlanningBlocked:
    """Result returned when a ChangeSet cannot produce planning scope."""

    change_set_id: str
    reason: str
