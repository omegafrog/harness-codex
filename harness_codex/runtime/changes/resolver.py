"""Resolve active ChangeSets into per-use-case planning scopes."""

from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    ChangeSet,
    PlanningBlocked,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.changes.parser import parse_changeset_markdown


APPROVED_STATUS = "approved"


class NoActiveChangeSetsError(FileNotFoundError):
    """Raised when the active ChangeSet directory contains no markdown files."""


class ChangeSetResolver:
    """Load active ChangeSets and derive planner/executor inputs."""

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
        relative_path = change_set_path.relative_to(self.repo_root)
        return parse_changeset_markdown(text, path=relative_path)

    def validate_active_change_set(
        self,
        change_set: ChangeSet,
    ) -> PlanningBlocked | None:
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
                use_case = _find_use_case(change_set, work_item.work_item_id)
                if use_case is None:
                    return PlanningBlocked(
                        change_set_id=change_set.change_set_id,
                        reason=(
                            f"Use case work item {work_item.work_item_id} "
                            "has no affected use-case row"
                        ),
                    )
                missing = _missing_use_case_documents(
                    self.repo_root,
                    use_case.slice_path,
                )
                if missing:
                    return PlanningBlocked(
                        change_set_id=change_set.change_set_id,
                        reason=(
                            f"Use case work item {work_item.work_item_id} "
                            "is missing required documents: "
                            + ", ".join(str(path) for path in missing)
                        ),
                    )
                approval_status = _use_case_approval_status(
                    self.repo_root,
                    use_case.slice_path / "e2e-goal.md",
                )
                if approval_status and approval_status.lower() != APPROVED_STATUS:
                    return PlanningBlocked(
                        change_set_id=change_set.change_set_id,
                        reason=(
                            f"Use case work item {work_item.work_item_id} "
                            "is waiting for E2E goal approval: "
                            f"status={approval_status} "
                            f"path={use_case.slice_path / 'e2e-goal.md'}. "
                            "Approve or refine the E2E goal before planning."
                        ),
                    )
                continue

            missing = _missing_maintenance_documents(self.repo_root, work_item.slice_path)
            if missing:
                return PlanningBlocked(
                    change_set_id=change_set.change_set_id,
                    reason=(
                        f"Maintenance work item {work_item.work_item_id} "
                        "is missing required documents: "
                        + ", ".join(str(path) for path in missing)
                    ),
                )

        return None

    def resolve_planning_scopes(
        self,
        change_set: ChangeSet,
    ) -> tuple[PlanningInputScope, ...] | PlanningBlocked:
        blocked = self.validate_active_change_set(change_set)
        if blocked is not None:
            return blocked

        work_items = change_set.ordered_work_items()
        change_set_path = change_set.path or Path(
            f"docs/changes/active/{change_set.change_set_id}.md"
        )
        scopes: list[PlanningInputScope] = []

        for work_item in work_items:
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
                scopes.append(
                    _use_case_scope(change_set, change_set_path, use_case)
                )
                continue

            scopes.append(
                _maintenance_scope(
                    repo_root=self.repo_root,
                    change_set_path=change_set_path,
                    work_item_id=work_item.work_item_id,
                    slice_path=work_item.slice_path,
                )
            )

        return tuple(scopes)

    def resolve_work_item_scopes(
        self,
        change_set: ChangeSet,
    ) -> tuple[PlanningInputScope, ...] | PlanningBlocked:
        return self.resolve_planning_scopes(change_set)


def _find_use_case(
    change_set: ChangeSet,
    uc_id: str,
) -> AffectedUseCase | None:
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
    e2e_goal_path = use_case.slice_path / "e2e-goal.md"
    plan_path = Path(f"docs/plans/active/{use_case.uc_id}/plan.md")
    executor_inputs = tuple(
        dict.fromkeys(
            (
                plan_path,
                use_case.slice_path / "use-case.md",
                use_case.slice_path / "event-storming.md",
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
        plan_path=plan_path,
        verification_goal_path=e2e_goal_path,
    )


def _maintenance_scope(
    *,
    repo_root: Path,
    change_set_path: Path,
    work_item_id: str,
    slice_path: Path,
) -> PlanningInputScope:
    plan_path = Path(f"docs/plans/active/{work_item_id}/plan.md")
    technical_decisions = slice_path / "technical-decisions.md"
    planner_inputs = tuple(
        path
        for path in (
            change_set_path,
            slice_path / "change-intent.md",
            slice_path / "affected-files.md",
            technical_decisions,
            slice_path / "verification-goal.md",
            Path("ARCHITECTURE.md"),
            Path(".codex/repository-settings.md"),
        )
        if path != technical_decisions or (repo_root / technical_decisions).exists()
    )
    executor_inputs = (
        plan_path,
        slice_path / "change-intent.md",
        slice_path / "affected-files.md",
        slice_path / "verification-goal.md",
        change_set_path,
        Path("ARCHITECTURE.md"),
        Path(".codex/repository-settings.md"),
    )
    return PlanningInputScope(
        change_set_path=change_set_path,
        use_case=None,
        planner_inputs=planner_inputs,
        executor_inputs=executor_inputs,
        e2e_goal_path=None,
        work_item_id=work_item_id,
        work_item_type=WorkItemType.MAINTENANCE,
        plan_path=plan_path,
        verification_goal_path=slice_path / "verification-goal.md",
    )


def _missing_use_case_documents(
    repo_root: Path,
    slice_path: Path,
) -> tuple[Path, ...]:
    required = (
        slice_path / "use-case.md",
        slice_path / "e2e-goal.md",
    )
    return tuple(path for path in required if not (repo_root / path).exists())


def _missing_maintenance_documents(
    repo_root: Path,
    slice_path: Path,
) -> tuple[Path, ...]:
    required = (
        slice_path / "change-intent.md",
        slice_path / "affected-files.md",
        slice_path / "verification-goal.md",
    )
    return tuple(path for path in required if not (repo_root / path).exists())


def _use_case_approval_status(repo_root: Path, e2e_goal_path: Path) -> str:
    absolute_path = repo_root / e2e_goal_path
    if not absolute_path.exists():
        return ""

    return _approval_status_from_markdown(absolute_path.read_text(encoding="utf-8"))


def _approval_status_from_markdown(text: str) -> str:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or "---" in stripped:
            continue
        cells = [cell.strip().strip("`") for cell in stripped.strip("|").split("|")]
        if len(cells) >= 2 and cells[0] in {"Approval Status", "승인 상태"}:
            return cells[1]
    return ""


def _replace_uc_placeholders(
    paths: tuple[Path, ...],
    change_set_id: str,
    uc_id: str,
) -> tuple[Path, ...]:
    return tuple(
        Path(
            str(path)
            .replace("<CHG-ID>", change_set_id)
            .replace("<UC-ID>", uc_id)
        )
        for path in paths
    )
