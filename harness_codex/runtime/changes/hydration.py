"""Hydrate legacy ChangeSet work-item data from slice documents."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    AffectedWorkItem,
    ChangeSet,
    WorkItemType,
)


def hydrate_change_set_work_items(repo_root: Path | str, change_set: ChangeSet) -> ChangeSet:
    """Fill missing affected use cases/work items from `docs/use-cases/UC-*` slices."""

    if change_set.ordered_work_items():
        return change_set

    root = Path(repo_root)
    use_cases = tuple(
        AffectedUseCase(
            uc_id=uc_id,
            name=_use_case_name(root / slice_path / "use-case.md", uc_id),
            impact_type="update",
            slice_path=slice_path,
            status="ready",
        )
        for uc_id, slice_path in _slice_use_cases(root)
    )
    work_items = tuple(
        AffectedWorkItem(
            work_item_id=use_case.uc_id,
            work_item_type=WorkItemType.USE_CASE,
            name=use_case.name,
            impact_type=use_case.impact_type,
            slice_path=use_case.slice_path,
            status=use_case.status,
        )
        for use_case in use_cases
    )
    if not work_items:
        return change_set
    return replace(
        change_set,
        affected_use_cases=change_set.affected_use_cases or use_cases,
        affected_work_items=work_items,
    )


def _slice_use_cases(root: Path) -> tuple[tuple[str, Path], ...]:
    slice_root = root / "docs/use-cases"
    if not slice_root.exists():
        return ()
    return tuple(
        (path.name, Path("docs/use-cases") / path.name)
        for path in sorted(slice_root.iterdir())
        if path.is_dir()
        and path.name.startswith("UC-")
        and (path / "use-case.md").exists()
        and (path / "e2e-goal.md").exists()
    )


def _use_case_name(path: Path, fallback: str) -> str:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped.startswith("# "):
                return stripped[2:].strip() or fallback
    except OSError:
        return fallback
    return fallback
