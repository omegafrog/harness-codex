"""Resolve active ChangeSets into per-work-item planning scopes."""

from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    AffectedWorkItem,
    ChangeSet,
    PlanningBlocked,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.changes.work_item_documents import (
    executor_input_paths,
    missing_required_documents,
    planner_input_paths,
    verification_goal_path,
)
from harness_codex.runtime.document_metadata import approval_status_from_metadata_or_markdown

APPROVED_STATUS = "approved"


class NoActiveChangeSetsError(FileNotFoundError):
    """Raised when the active ChangeSet directory contains no markdown files."""


class ChangeSetResolver:
    """Load active ChangeSets and derive type-aware planner/executor inputs."""

    def __init__(self, repo_root: Path | str) -> None:
        self.repo_root = Path(repo_root)

    def list_active(self) -> tuple[ChangeSet, ...]:
        active_dir = self.repo_root / "docs/changes/active"
        paths = sorted(active_dir.glob("*.md"))
        if not paths:
            raise NoActiveChangeSetsError(
                f"No active ChangeSet markdown files found in {active_dir}"
            )
        return tuple(self.load(path) for path in paths)

    def load(self, path: Path | str) -> ChangeSet:
        change_set_path = Path(path)
        if not change_set_path.is_absolute():
            change_set_path = self.repo_root / change_set_path
        text = change_set_path.read_text(encoding="utf-8")
        return parse_changeset_markdown(
            text,
            path=change_set_path.relative_to(self.repo_root),
        )

    def validate_active_change_set(self, change_set: ChangeSet) -> PlanningBlocked | None:
        """Validate the ChangeSet-first runtime contract before execution."""

        change_set_path = change_set.path or Path(
            f"docs/changes/active/{change_set.change_set_id}.md"
        )
        expected_path = Path("docs/changes/active") / f"{change_set.change_set_id}.md"
        if not (self.repo_root / change_set_path).exists():
            return PlanningBlocked(
                change_set_id=change_set.change_set_id,
                reason=f"Active ChangeSet file does not exist: {change_set_path}",
            )
        if change_set_path != expected_path:
            return PlanningBlocked(
                change_set_id=change_set.change_set_id,
                reason=(
                    "ChangeSet ID and active path do not match: "
                    f"id={change_set.change_set_id} path={change_set_path}"
                ),
            )

        work_items = change_set.ordered_work_items()
        if not work_items:
            return PlanningBlocked(
                change_set_id=change_set.change_set_id,
                reason="ChangeSet has no affected work items",
            )

        for work_item in work_items:
            if not (self.repo_root / work_item.slice_path).exists():
                return PlanningBlocked(
                    change_set_id=change_set.change_set_id,
                    reason=(
                        f"Work item {work_item.work_item_id} slice path does not exist: "
                        f"{work_item.slice_path}"
                    ),
                )
            if work_item.work_item_type == WorkItemType.USE_CASE:
                blocked = self._validate_use_case_work_item(change_set, work_item)
            else:
                blocked = self._validate_typed_work_item(change_set, work_item)
            if blocked is not None:
                return blocked
        return None

    def resolve_planning_scopes(
        self,
        change_set: ChangeSet,
    ) -> tuple[PlanningInputScope, ...] | PlanningBlocked:
        blocked = self.validate_active_change_set(change_set)
        if blocked is not None:
            return blocked

        change_set_path = change_set.path or Path(
            f"docs/changes/active/{change_set.change_set_id}.md"
        )
        scopes: list[PlanningInputScope] = []
        for work_item in change_set.ordered_work_items():
            if work_item.work_item_type == WorkItemType.USE_CASE:
                use_case = _find_use_case(change_set, work_item.work_item_id)
                if use_case is None:
                    return PlanningBlocked(
                        change_set_id=change_set.change_set_id,
                        reason=(
                            f"Use case work item {work_item.work_item_id} "
                            "has no affected use-case row"
                        ),
                    )
                scopes.append(_use_case_scope(change_set, change_set_path, use_case))
            else:
                scopes.append(
                    _typed_work_item_scope(
                        repo_root=self.repo_root,
                        change_set_path=change_set_path,
                        work_item=work_item,
                    )
                )
        return tuple(scopes)

    def resolve_work_item_scopes(
        self,
        change_set: ChangeSet,
    ) -> tuple[PlanningInputScope, ...] | PlanningBlocked:
        return self.resolve_planning_scopes(change_set)

    def _validate_use_case_work_item(
        self,
        change_set: ChangeSet,
        work_item: AffectedWorkItem,
    ) -> PlanningBlocked | None:
        use_case = _find_use_case(change_set, work_item.work_item_id)
        if use_case is None:
            return PlanningBlocked(
                change_set_id=change_set.change_set_id,
                reason=(
                    f"Use case work item {work_item.work_item_id} "
                    "has no affected use-case row"
                ),
            )
        missing = _missing_use_case_documents(self.repo_root, use_case.slice_path)
        if missing:
            return PlanningBlocked(
                change_set_id=change_set.change_set_id,
                reason=(
                    f"Use case work item {work_item.work_item_id} "
                    "is missing required documents: "
                    + ", ".join(str(path) for path in missing)
                ),
            )
        approval_found, approval_status, approval_path = _approval_status_for_use_case(
            self.repo_root,
            change_set,
            use_case,
        )
        if approval_found and approval_status.lower() != APPROVED_STATUS:
            return PlanningBlocked(
                change_set_id=change_set.change_set_id,
                reason=(
                    f"Use case work item {work_item.work_item_id} "
                    "is waiting for E2E goal approval: "
                    f"status={approval_status or '<blank>'} path={approval_path}. "
                    "Approve or refine the E2E goal before planning."
                ),
            )
        technical_blocked = _technical_decision_blocker(
            self.repo_root,
            work_item.work_item_id,
            use_case.slice_path / "technical-decisions.md",
        )
        if technical_blocked:
            return PlanningBlocked(
                change_set_id=change_set.change_set_id,
                reason=technical_blocked,
            )
        return None

    def _validate_typed_work_item(
        self,
        change_set: ChangeSet,
        work_item: AffectedWorkItem,
    ) -> PlanningBlocked | None:
        missing = missing_required_documents(self.repo_root, work_item)
        if not missing:
            return None
        label = "Maintenance" if work_item.work_item_type == WorkItemType.MAINTENANCE else work_item.work_item_type.value
        return PlanningBlocked(
            change_set_id=change_set.change_set_id,
            reason=(
                f"{label} work item {work_item.work_item_id} is missing required documents: "
                + ", ".join(str(path) for path in missing)
            ),
        )


def _find_use_case(change_set: ChangeSet, uc_id: str) -> AffectedUseCase | None:
    for use_case in change_set.affected_use_cases:
        if use_case.uc_id == uc_id:
            return use_case
    return None


def _use_case_scope(
    change_set: ChangeSet,
    change_set_path: Path,
    use_case: AffectedUseCase,
) -> PlanningInputScope:
    planner_inputs = _replace_uc_placeholders(
        change_set.planner_inputs,
        change_set.change_set_id,
        use_case.uc_id,
    )
    planner_inputs = tuple(
        dict.fromkeys(
            (
                *planner_inputs,
                use_case.slice_path / "use-case.md",
                use_case.slice_path / "event-storming.md",
                use_case.slice_path / "ddd-design.md",
                use_case.slice_path / "technical-decisions.md",
                use_case.slice_path / "e2e-goal.md",
                Path("ARCHITECTURE.md"),
                Path(".codex/repository-settings.md"),
            )
        )
    )
    e2e_goal_path = use_case.slice_path / "e2e-goal.md"
    plan_path = Path(f"docs/plans/active/{use_case.uc_id}/plan.md")
    executor_inputs = tuple(
        dict.fromkeys(
            (
                plan_path,
                use_case.slice_path / "use-case.md",
                use_case.slice_path / "event-storming.md",
                use_case.slice_path / "ddd-design.md",
                use_case.slice_path / "technical-decisions.md",
                e2e_goal_path,
                change_set_path,
                Path("ARCHITECTURE.md"),
                Path(".codex/repository-settings.md"),
            )
        )
    )
    return PlanningInputScope(
        change_set_path=change_set_path,
        use_case=use_case,
        planner_inputs=planner_inputs,
        executor_inputs=executor_inputs,
        e2e_goal_path=e2e_goal_path,
        work_item_id=use_case.uc_id,
        work_item_type=WorkItemType.USE_CASE,
        impact_type=use_case.impact_type,
        plan_path=plan_path,
        verification_goal_path=e2e_goal_path,
    )


def _typed_work_item_scope(
    *,
    repo_root: Path,
    change_set_path: Path,
    work_item: AffectedWorkItem,
) -> PlanningInputScope:
    plan_path = Path(f"docs/plans/active/{work_item.work_item_id}/plan.md")
    return PlanningInputScope(
        change_set_path=change_set_path,
        use_case=None,
        planner_inputs=planner_input_paths(
            repo_root,
            change_set_path=change_set_path,
            work_item=work_item,
        ),
        executor_inputs=executor_input_paths(
            repo_root,
            change_set_path=change_set_path,
            work_item=work_item,
            plan_path=plan_path,
        ),
        e2e_goal_path=None,
        work_item_id=work_item.work_item_id,
        work_item_type=work_item.work_item_type,
        impact_type=work_item.impact_type,
        plan_path=plan_path,
        verification_goal_path=verification_goal_path(work_item),
    )


def _missing_use_case_documents(repo_root: Path, slice_path: Path) -> tuple[Path, ...]:
    required = (
        slice_path / "use-case.md",
        slice_path / "event-storming.md",
        slice_path / "ddd-design.md",
        slice_path / "technical-decisions.md",
        slice_path / "e2e-goal.md",
    )
    return tuple(path for path in required if not (repo_root / path).exists())


def _approval_status_for_use_case(
    repo_root: Path,
    change_set: ChangeSet,
    use_case: AffectedUseCase,
) -> tuple[bool, str, Path]:
    e2e_goal_path = use_case.slice_path / "e2e-goal.md"
    for approval in change_set.goal_approvals:
        if approval.work_item_id == use_case.uc_id:
            return True, approval.approval_status, approval.path
    found, status = _use_case_approval_status(repo_root, e2e_goal_path)
    return found, status, e2e_goal_path


def _use_case_approval_status(repo_root: Path, e2e_goal_path: Path) -> tuple[bool, str]:
    absolute_path = repo_root / e2e_goal_path
    if not absolute_path.exists():
        return False, ""
    return approval_status_from_metadata_or_markdown(
        absolute_path.read_text(encoding="utf-8")
    )


def _technical_decision_blocker(
    repo_root: Path,
    work_item_id: str,
    technical_decisions_path: Path,
) -> str | None:
    absolute_path = repo_root / technical_decisions_path
    if not absolute_path.exists():
        return None
    found, status = approval_status_from_metadata_or_markdown(
        absolute_path.read_text(encoding="utf-8")
    )
    if found and status.lower() != APPROVED_STATUS:
        return (
            f"Work item {work_item_id} is waiting for technical decision approval: "
            f"status={status or '<blank>'} path={technical_decisions_path}"
        )
    return None


def _replace_uc_placeholders(
    paths: tuple[Path, ...],
    change_set_id: str,
    uc_id: str,
) -> tuple[Path, ...]:
    replacements = {
        "<CHG-ID>": change_set_id,
        "<UC-ID>": uc_id,
    }
    return tuple(
        Path(_replace_placeholders(str(path), replacements))
        for path in paths
    )


def _replace_placeholders(value: str, replacements: dict[str, str]) -> str:
    result = value
    for placeholder, replacement in replacements.items():
        result = result.replace(placeholder, replacement)
    return result
