"""Typed work-item document contracts and non-destructive scaffolding.

Use-case slices are created by the README design stages. Non-UC work items use
this module to create a small, type-specific slice without inventing a use case.
The generator only creates missing files; it never replaces authored content.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable, Sequence

from harness_codex.runtime.changes.models import AffectedWorkItem, ChangeSet, WorkItemType
from harness_codex.runtime.changes.parser import parse_changeset_markdown


_COMMON_DOCUMENTS = (
    "brief.md",
    "architecture-impact.md",
    "verification-goal.md",
    "links.md",
)

_TYPE_DOCUMENTS: dict[WorkItemType, tuple[str, ...]] = {
    WorkItemType.USE_CASE: (),
    WorkItemType.MAINTENANCE: (
        "scope.md",
        "change-intent.md",
        "affected-files.md",
        "maintenance-spec.md",
    ),
    WorkItemType.BUG_FIX: ("reproduction.md", "regression-goal.md"),
    WorkItemType.REFACTORING: ("refactoring-contract.md",),
    WorkItemType.FEATURE_EXTENSION: ("acceptance-delta.md",),
}

# A maintenance slice is independent of a UC slice. Its required documents make
# the operational scope, code boundary, architecture assessment, and verification
# contract explicit, so planner/executor inputs never fall back to UC-only paths.
_REQUIRED_DOCUMENTS: dict[WorkItemType, tuple[str, ...]] = {
    WorkItemType.USE_CASE: (
        "use-case.md",
        "event-storming.md",
        "ddd-design.md",
        "technical-decisions.md",
        "e2e-goal.md",
    ),
    WorkItemType.MAINTENANCE: (
        "scope.md",
        "change-intent.md",
        "affected-files.md",
        "maintenance-spec.md",
        "architecture-impact.md",
        "verification-goal.md",
        "links.md",
    ),
    WorkItemType.BUG_FIX: _COMMON_DOCUMENTS + ("reproduction.md", "regression-goal.md"),
    WorkItemType.REFACTORING: _COMMON_DOCUMENTS + ("refactoring-contract.md",),
    WorkItemType.FEATURE_EXTENSION: _COMMON_DOCUMENTS + ("acceptance-delta.md",),
}


def required_document_paths(work_item: AffectedWorkItem) -> tuple[Path, ...]:
    """Return the documents that must exist before the work item can be planned."""

    return tuple(work_item.slice_path / name for name in _REQUIRED_DOCUMENTS[work_item.work_item_type])


def scaffold_document_paths(work_item: AffectedWorkItem) -> tuple[Path, ...]:
    """Return all documents created for a non-UC work item."""

    if work_item.work_item_type == WorkItemType.USE_CASE:
        return ()
    names = (*_COMMON_DOCUMENTS, *_TYPE_DOCUMENTS[work_item.work_item_type])
    return tuple(dict.fromkeys(work_item.slice_path / name for name in names))


def verification_goal_path(work_item: AffectedWorkItem) -> Path:
    """Return the verification contract used by the work-item verifier."""

    if work_item.work_item_type == WorkItemType.USE_CASE:
        return work_item.slice_path / "e2e-goal.md"
    return work_item.slice_path / "verification-goal.md"


def missing_required_documents(repo_root: Path | str, work_item: AffectedWorkItem) -> tuple[Path, ...]:
    """Return required contract documents absent from the repository."""

    root = Path(repo_root)
    return tuple(path for path in required_document_paths(work_item) if not (root / path).is_file())


def planner_input_paths(
    repo_root: Path | str,
    *,
    change_set_path: Path,
    work_item: AffectedWorkItem,
) -> tuple[Path, ...]:
    """Resolve type-aware planner inputs without UC/maintenance path guessing."""

    root = Path(repo_root)
    candidates = (
        change_set_path,
        *required_document_paths(work_item),
        *scaffold_document_paths(work_item),
        Path("ARCHITECTURE.md"),
        Path(".codex/repository-settings.md"),
    )
    return _existing_or_required(root, candidates, required=(change_set_path, *required_document_paths(work_item)))


def executor_input_paths(
    repo_root: Path | str,
    *,
    change_set_path: Path,
    work_item: AffectedWorkItem,
    plan_path: Path,
) -> tuple[Path, ...]:
    """Resolve type-aware executor inputs, retaining the active plan even before it exists."""

    return tuple(
        dict.fromkeys(
            (
                plan_path,
                *planner_input_paths(
                    repo_root,
                    change_set_path=change_set_path,
                    work_item=work_item,
                ),
            )
        )
    )


def scaffold_work_item_documents(
    repo_root: Path | str,
    work_item: AffectedWorkItem,
) -> tuple[Path, ...]:
    """Create missing non-UC document templates and return created relative paths.

    The function deliberately does not scaffold use-case design artifacts. Those
    files are owned by the README stages from use-case-definition through
    technical-decisions and must not be replaced with empty templates.
    """

    if work_item.work_item_type == WorkItemType.USE_CASE:
        return ()

    root = Path(repo_root)
    created: list[Path] = []
    for relative_path in scaffold_document_paths(work_item):
        absolute_path = root / relative_path
        if absolute_path.exists():
            continue
        absolute_path.parent.mkdir(parents=True, exist_ok=True)
        absolute_path.write_text(_render_document(work_item, relative_path.name), encoding="utf-8")
        created.append(relative_path)
    return tuple(created)


def scaffold_change_set_work_items(
    repo_root: Path | str,
    change_set: ChangeSet,
    *,
    work_item_id: str | None = None,
) -> tuple[Path, ...]:
    """Scaffold one or all non-UC work items in a ChangeSet."""

    created: list[Path] = []
    for work_item in change_set.ordered_work_items():
        if work_item_id and work_item.work_item_id != work_item_id:
            continue
        created.extend(scaffold_work_item_documents(repo_root, work_item))
    if work_item_id and not any(item.work_item_id == work_item_id for item in change_set.ordered_work_items()):
        raise ValueError(f"Work item {work_item_id} is not affected by {change_set.change_set_id}")
    return tuple(created)


def _existing_or_required(
    root: Path,
    candidates: Iterable[Path],
    *,
    required: Iterable[Path],
) -> tuple[Path, ...]:
    required_paths = set(required)
    paths: list[Path] = []
    for path in candidates:
        if path in required_paths or (root / path).exists():
            paths.append(path)
    return tuple(dict.fromkeys(paths))


def _render_document(work_item: AffectedWorkItem, filename: str) -> str:
    frontmatter = (
        "---\n"
        f"work_item_id: {work_item.work_item_id}\n"
        f"work_item_type: {work_item.work_item_type.value}\n"
        "status: draft\n"
        "---\n\n"
    )
    title = f"# {work_item.work_item_id}. {work_item.name or work_item.work_item_type.value}\n\n"
    bodies = {
        "brief.md": (
            "## Goal\n\n- TODO: describe the intended outcome.\n\n"
            "## Non-goals\n\n- TODO\n\n## Dependencies\n\n- TODO\n"
        ),
        "scope.md": (
            "## Maintenance Scope\n\n"
            "- Bounded context: TODO\n"
            "- Aggregate: TODO or `none`\n"
            "- Application service: TODO or `none`\n"
            "- Module or package: TODO\n"
            "- Adapter or port: TODO or `none`\n"
            "- Why this boundary is the smallest safe change: TODO\n"
        ),
        "architecture-impact.md": (
            "## Architecture Impact\n\n"
            "- Decision: `none` (`none` | `update` | `create` | `adr`)\n"
            "- Reason: TODO\n"
            "- Canonical architecture references: TODO or `none`\n"
            "- Required canonical document update: TODO or `none`\n"
        ),
        "verification-goal.md": (
            "## Verification Goal\n\n"
            "- Observable success condition: TODO\n"
            "- Required command evidence: TODO\n"
            "- Regression or compatibility condition: TODO\n"
        ),
        "links.md": (
            "## Links\n\n"
            "- ChangeSet: TODO\n"
            "- Related issue: TODO\n"
            "- Related UC, ADR, or architecture document: TODO\n"
        ),
        "change-intent.md": (
            "## Change Intent\n\n"
            "- Problem or operational goal: TODO\n"
            "- Expected improvement: TODO\n"
        ),
        "affected-files.md": (
            "## Affected Files and Boundaries\n\n"
            "- Included modules or files: TODO\n"
            "- Excluded modules or files: TODO\n"
            "- Caller-facing or persistence compatibility boundary: TODO\n"
        ),
        "maintenance-spec.md": (
            "## Maintenance Specification\n\n"
            "- Current condition: TODO\n"
            "- Target metric or operational property: TODO\n"
            "- Rollback: TODO\n"
        ),
        "reproduction.md": (
            "## Reproduction\n\n"
            "- Preconditions: TODO\n"
            "- Steps: TODO\n"
            "- Expected result: TODO\n"
            "- Actual result: TODO\n"
        ),
        "regression-goal.md": (
            "## Regression Goal\n\n"
            "- Failure that must not recur: TODO\n"
            "- Test level and scenario: TODO\n"
        ),
        "refactoring-contract.md": (
            "## Refactoring Contract\n\n"
            "- Structural intent: TODO\n"
            "- Preserved public behavior and invariants: TODO\n"
            "- Forbidden behavior changes: TODO\n"
        ),
        "acceptance-delta.md": (
            "## Acceptance Delta\n\n"
            "- Parent UC or new-UC decision: TODO\n"
            "- Changed acceptance conditions: TODO\n"
            "- Compatibility and migration impact: TODO\n"
        ),
    }
    return frontmatter + title + bodies[filename]


def main(argv: Sequence[str] | None = None) -> int:
    """Scaffold typed non-UC work-item documents without overwriting authored text."""

    parser = argparse.ArgumentParser(description="Scaffold typed ChangeSet work-item documents.")
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", default="")
    parser.add_argument("--check", action="store_true", help="Fail when required documents are missing.")
    args = parser.parse_args(argv)

    root = Path(args.repo_root)
    change_set_path = root / "docs/changes/active" / f"{args.change_set}.md"
    if not change_set_path.is_file():
        raise ValueError(f"Active ChangeSet file not found: {change_set_path.relative_to(root)}")
    change_set = parse_changeset_markdown(
        change_set_path.read_text(encoding="utf-8"),
        path=change_set_path.relative_to(root),
    )
    selected = tuple(
        item
        for item in change_set.ordered_work_items()
        if not args.work_item or item.work_item_id == args.work_item
    )
    if not selected:
        raise ValueError(f"Work item {args.work_item} is not affected by {change_set.change_set_id}")

    if args.check:
        missing = tuple(
            path
            for item in selected
            for path in missing_required_documents(root, item)
        )
        if missing:
            print("MISSING: " + ", ".join(str(path) for path in missing))
            return 1
        print("PASS: typed work-item document contracts are complete")
        return 0

    created = tuple(path for item in selected for path in scaffold_work_item_documents(root, item))
    print("CREATED: " + (", ".join(str(path) for path in created) if created else "none"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
