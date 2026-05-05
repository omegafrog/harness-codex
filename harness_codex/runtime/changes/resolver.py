"""Resolve active ChangeSets into per-use-case planning scopes."""

from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.changes.models import (
    ChangeSet,
    PlanningBlocked,
    PlanningInputScope,
)
from harness_codex.runtime.changes.parser import parse_changeset_markdown


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

    def resolve_planning_scopes(
        self,
        change_set: ChangeSet,
    ) -> tuple[PlanningInputScope, ...] | PlanningBlocked:
        if not change_set.affected_use_cases:
            return PlanningBlocked(
                change_set_id=change_set.change_set_id,
                reason="ChangeSet has no affected use cases",
            )

        change_set_path = change_set.path or Path(
            f"docs/changes/active/{change_set.change_set_id}.md"
        )
        scopes: list[PlanningInputScope] = []

        for use_case in change_set.affected_use_cases:
            planner_inputs = _replace_uc_placeholders(
                change_set.planner_inputs,
                change_set.change_set_id,
                use_case.uc_id,
            )
            e2e_goal_path = use_case.slice_path / "e2e-goal.md"
            executor_inputs = tuple(
                dict.fromkeys(
                    (
                        Path(f"docs/plans/active/{use_case.uc_id}/plan.md"),
                        use_case.slice_path / "use-case.md",
                        use_case.slice_path / "event-storming.md",
                        e2e_goal_path,
                        change_set_path,
                        Path("ARCHITECTURE.md"),
                        Path(".codex/repository-settings.md"),
                    )
                )
            )

            scopes.append(
                PlanningInputScope(
                    change_set_path=change_set_path,
                    use_case=use_case,
                    planner_inputs=planner_inputs,
                    executor_inputs=executor_inputs,
                    e2e_goal_path=e2e_goal_path,
                )
            )

        return tuple(scopes)


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
