"""Explicit reset helper for local harness runtime artifacts."""

from __future__ import annotations

import argparse
import shutil
from dataclasses import dataclass
from pathlib import Path

RUN_STATE_PATHS = (
    Path(".harness/runs"),
    Path(".harness/sessions"),
    Path(".harness/state"),
    Path(".harness/checkpoints"),
)

WORKFLOW_ARTIFACT_PATHS = (
    Path(".harness/ui/grill-me-runs"),
    Path("docs/changes"),
    Path("docs/use-cases"),
    Path("docs/maintenance"),
    Path("docs/plans"),
    Path("context.md"),
)


@dataclass(frozen=True)
class ResetResult:
    mode: str
    applied: bool
    targets: tuple[Path, ...]
    affected: tuple[Path, ...]


def main(argv: list[str] | None = None, *, repo_root: Path | str = ".") -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        result = run_reset(Path(repo_root), args)
    except ValueError as exc:
        print(str(exc))
        return 2
    print(format_result(result))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="harness reset",
        description="Reset local harness runtime artifacts explicitly.",
        epilog=(
            "Reset is intentionally separate from `harness update`. "
            "By default it only prints the target paths. Pass --apply to change files."
        ),
    )
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument(
        "--runs",
        action="store_true",
        help="Target local run/session/checkpoint state only.",
    )
    scope.add_argument(
        "--workflow-artifacts",
        action="store_true",
        help="Target workflow output artifacts such as ChangeSets, work-item slices, plans, and harvest UI runs.",
    )
    scope.add_argument(
        "--all",
        action="store_true",
        help="Target both local run state and workflow output artifacts.",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Apply the reset. Without this flag, reset runs as a dry run.",
    )
    return parser


def run_reset(repo_root: Path, args: argparse.Namespace) -> ResetResult:
    targets = selected_targets(args)
    affected = tuple(path for path in targets if (repo_root / path).exists())
    if args.apply:
        for path in affected:
            _remove_path(repo_root / path)
    return ResetResult(
        mode=selected_mode(args),
        applied=bool(args.apply),
        targets=targets,
        affected=affected,
    )


def selected_targets(args: argparse.Namespace) -> tuple[Path, ...]:
    if args.runs:
        return RUN_STATE_PATHS
    if args.workflow_artifacts:
        return WORKFLOW_ARTIFACT_PATHS
    if args.all:
        return RUN_STATE_PATHS + WORKFLOW_ARTIFACT_PATHS
    raise ValueError("select one reset scope: --runs, --workflow-artifacts, or --all")


def selected_mode(args: argparse.Namespace) -> str:
    if args.runs:
        return "runs"
    if args.workflow_artifacts:
        return "workflow-artifacts"
    if args.all:
        return "all"
    return "unknown"


def format_result(result: ResetResult) -> str:
    header = "APPLIED" if result.applied else "DRY RUN"
    lines = [
        f"{header}: harness reset --{result.mode}",
        "Targets:",
        *[f"- {path}" for path in result.targets],
        "Existing targets:",
    ]
    if result.affected:
        lines.extend(f"- {path}" for path in result.affected)
    else:
        lines.append("- none")
    if not result.applied:
        lines.append("Pass --apply to apply this reset.")
    return "\n".join(lines)


def _remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()
