"""Public command entrypoint with explicit session composition.

The legacy stage CLI remains the command parser for backward-compatible command
syntax. Implementation execution is routed here so it can call the ChangeSet
coordinator directly rather than relying on a bootstrap-time assignment to
``cli._apply_workflow``.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

from harness_codex import canonical_cli
from harness_codex import cli as stage_cli
from harness_codex.runtime import RunMode
from harness_codex.runtime.changes import DesignBridgeError, NoActiveChangeSetsError, PlanningBlocked
from harness_codex.runtime.changeset_orchestrator import apply_workflow
from harness_codex.runtime.dashboard_legacy_migration import migrate_legacy_dashboard_sessions
from harness_codex.runtime.memory import MemoryError
from harness_codex.runtime.preflight import run_workflow_preflight, write_preflight_result
from harness_codex.runtime.session_progress import StepLedgerProgressReporter
from harness_codex.runtime.state_projection import (
    migrate_legacy_runtime_state,
    persist_canonical_run_state,
)
from harness_codex.runtime.workflows import WorkflowMaterializationError


def main(argv: Sequence[str] | None = None) -> int:
    """Run the public command surface with direct implementation composition."""

    arguments = list(sys.argv[1:] if argv is None else argv)
    repo_root = _repo_root_from_arguments(arguments)
    # Migration is an executable-startup concern, never a dashboard rendering
    # concern. New runs update the index through persist_canonical_run_state.
    migrate_legacy_dashboard_sessions(repo_root)
    migrate_legacy_runtime_state(repo_root)
    if not _needs_direct_session_dispatch(arguments):
        return canonical_cli.main(arguments)

    parser = stage_cli.build_parser()
    parsed = parser.parse_args(arguments)
    repo_root = Path(parsed.repo_root)
    try:
        if parsed.func is stage_cli.procedure_stage_command:
            output = _run_implementation_stage(parsed, repo_root)
        else:
            output = _run_changes_continue(parsed, repo_root)
    except (
        NoActiveChangeSetsError,
        DesignBridgeError,
        WorkflowMaterializationError,
        MemoryError,
        ValueError,
    ) as exc:
        print(str(exc), file=sys.stderr)
        return 2

    if isinstance(output, int):
        return output
    if output:
        print(output)
    return 0


def _repo_root_from_arguments(arguments: Sequence[str]) -> Path:
    values = list(arguments)
    for index, value in enumerate(values):
        if value == "--repo-root" and index + 1 < len(values):
            return Path(values[index + 1])
        if value.startswith("--repo-root="):
            return Path(value.split("=", maxsplit=1)[1])
    return Path(".")


def _needs_direct_session_dispatch(arguments: Sequence[str]) -> bool:
    command, remaining = _command_and_remaining(arguments)
    if command == "implementation":
        return True
    return command == "changes" and bool(remaining) and remaining[0] == "continue"


def _command_and_remaining(arguments: Sequence[str]) -> tuple[str | None, list[str]]:
    index = 0
    values = list(arguments)
    while index < len(values):
        value = values[index]
        if value == "--repo-root":
            index += 2
            continue
        if value.startswith("--repo-root="):
            index += 1
            continue
        if value.startswith("-"):
            index += 1
            continue
        return value, values[index + 1 :]
    return None, []


def _run_implementation_stage(args: argparse.Namespace, repo_root: Path) -> str:
    if args.procedure_stage_id != "implementation":
        return stage_cli.procedure_stage_command(args, repo_root)
    args.change_set_id = stage_cli._resolve_procedure_change_set_id(
        repo_root,
        args,
        stage_cli._selected_mode(args),
    )
    return _run_implementation(args, repo_root)


def _run_changes_continue(args: argparse.Namespace, repo_root: Path) -> str:
    mode = stage_cli._selected_mode(args)
    change_set = stage_cli._load_change_set(repo_root, args.change_set_id)
    stage_cli._ensure_stage_handoff_state(repo_root, change_set.change_set_id)
    decision = stage_cli._decide_changes_continue_target(
        repo_root,
        change_set,
        uc_override=args.uc.strip() or None,
    )
    if decision.get("requires_blocker_resolution") or decision.get("blocked"):
        return stage_cli.changes_continue_command(args, repo_root)
    if decision.get("stage_id") != "implementation":
        return stage_cli.changes_continue_command(args, repo_root)

    stage_args = argparse.Namespace(
        procedure_stage_id="implementation",
        change_set_id=change_set.change_set_id,
        uc=decision.get("uc_id") or "",
        title="",
        idea="",
        force=bool(decision.get("force")),
        plan=mode == RunMode.PLAN,
        preview=mode == RunMode.PREVIEW,
        apply=mode == RunMode.APPLY,
        force_verification=bool(getattr(args, "force_verification", False)),
        rollback="none",
    )
    header = [
        f"Continue: {change_set.change_set_id}",
        "Target stage: implementation",
        f"UC: {decision.get('uc_id') or '-'}",
        f"Reason: {decision.get('reason') or '-'}",
    ]
    return "\n".join([*header, _run_implementation(stage_args, repo_root)])


def _run_implementation(args: argparse.Namespace, repo_root: Path) -> str:
    mode = stage_cli._selected_mode(args)
    change_set = stage_cli._load_change_set(repo_root, args.change_set_id)
    resolver = stage_cli.ChangeSetResolver(repo_root)
    scopes = resolver.resolve_planning_scopes(change_set)
    if isinstance(scopes, PlanningBlocked):
        return f"BLOCKED: {scopes.reason}"

    selected_work_item = str(getattr(args, "uc", "") or "").strip()
    if selected_work_item:
        scopes = tuple(scope for scope in scopes if scope.display_id == selected_work_item)
        if not scopes:
            raise ValueError(
                "implementation --uc must identify an affected work item: "
                f"{selected_work_item}"
            )
    if mode in (RunMode.PLAN, RunMode.PREVIEW):
        return stage_cli._format_scopes(change_set, scopes, mode)

    run_id = stage_cli._resumable_worktree_isolation_run_id(
        repo_root,
        change_set.change_set_id,
    ) or f"run-{stage_cli.uuid4().hex[:12]}"
    preflight = run_workflow_preflight(repo_root, change_set.change_set_id, scopes)
    preflight_path = write_preflight_result(repo_root, run_id, preflight)
    if not preflight.passed:
        return stage_cli._format_preflight_blocked(
            change_set.change_set_id,
            run_id,
            preflight_path,
            preflight,
        )

    with StepLedgerProgressReporter(repo_root, run_id, print):
        state, result = apply_workflow(
            repo_root,
            change_set,
            scopes,
            run_id=run_id,
            force_verification=bool(getattr(args, "force_verification", False)),
            rollback_mode=str(getattr(args, "rollback", "none") or "none"),
            workflow_loader=_load_session_workflow,
            workflow_materializer=stage_cli.materialize_workflow_for_scope,
            manifest_writer=stage_cli.write_materialized_workflow_manifest,
            engine_factory=lambda: stage_cli.RunnerEngine(stage_cli.BasicStepRunner()),
            emit=print,
        )
    state = persist_canonical_run_state(repo_root, state)
    execution = stage_cli._implementation_execution_summary(result)
    active_changeset_moved = (
        not (repo_root / "docs/changes/active" / f"{change_set.change_set_id}.md").exists()
        and (repo_root / "docs/changes/completed" / f"{change_set.change_set_id}.md").exists()
    )
    return (
        f"APPLY started: run_id={state.run_id} status={result.status.value} "
        f"active_changeset_moved={str(active_changeset_moved).lower()}{execution}"
    )


def _load_session_workflow(*loader_args, **loader_kwargs):
    workflow = stage_cli.load_named_workflow(*loader_args, **loader_kwargs)
    if not hasattr(workflow, "steps"):
        setattr(workflow, "steps", ())
    return workflow
