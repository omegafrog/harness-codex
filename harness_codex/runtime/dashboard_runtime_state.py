"""Canonical ChangeSet runtime state for dashboard-driven design stages.

The browser dashboard used to keep an independent harvest session under
``.harness/ui/change-sets``.  That was useful for resuming questions, but it
must not be the source of truth for procedure gates.  This module projects
completed dashboard stages into one deterministic ``RunState`` per active
ChangeSet, mirrors that state back to the ChangeSet table, and prevents local
UI state from unlocking planning or implementation.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import replace
from pathlib import Path
from typing import Any

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.changes.hydration import hydrate_change_set_work_items
from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.procedure_stages import (
    PROCEDURE_STAGES,
    parse_procedure_stage_rows,
    update_changeset_stage_status,
)
from harness_codex.runtime.state import (
    ArtifactDirtyState,
    RunState,
    RunStateStore,
    StageArtifactState,
    runtime_stage_projection,
)

_CANONICAL_RUN_PREFIX = "changeset-state-"
_PATCHED_ATTR = "_harness_dashboard_runtime_state_patch_applied"
_ORIGINAL_SAVE_ATTR = "_harness_dashboard_runtime_state_original_save"
_UBIQUITOUS_LANGUAGE_PATH = Path("docs/design/ubiquitous-language.md")


def canonical_run_id(change_set_id: str) -> str:
    """Return the deterministic RunState id for one ChangeSet."""

    return _CANONICAL_RUN_PREFIX + re.sub(r"[^A-Za-z0-9_.-]+", "-", change_set_id)


def load_canonical_change_set_state(
    repo_root: Path | str, change_set_id: str
) -> RunState | None:
    """Load the authoritative dashboard/CLI projection for one ChangeSet."""

    store = RunStateStore(repo_root)
    try:
        return store.load(canonical_run_id(change_set_id))
    except (FileNotFoundError, KeyError, TypeError, ValueError):
        return None


def sync_change_set_runtime_state(
    repo_root: Path | str,
    change_set_id: str,
    session: dict[str, Any],
) -> RunState:
    """Persist dashboard-complete stages as accepted canonical artifacts.

    A false or absent dashboard flag never downgrades a previously accepted
    runtime artifact.  Invalidations are handled by the owner that changed the
    upstream artifact; this function only records positive, validated UI
    progress.
    """

    root = Path(repo_root)
    change_path = _active_change_set_path(root, change_set_id)
    if change_path is None:
        raise ValueError(f"Active ChangeSet does not exist: {change_set_id}.")

    affected_use_cases, affected_work_items = _affected_work_items(root, change_path)
    current = load_canonical_change_set_state(root, change_set_id)
    dashboard_artifacts = _dashboard_stage_artifacts(
        root,
        session,
        affected_use_cases,
    )
    state = _build_canonical_state(
        change_set_id=change_set_id,
        affected_use_cases=affected_use_cases,
        affected_work_items=affected_work_items,
        current=current,
        artifacts=dashboard_artifacts,
    )
    RunStateStore(root).save(state)
    reconcile_change_set_procedure_table(root, state)
    return state


def reconcile_change_set_procedure_table(repo_root: Path | str, state: RunState) -> None:
    """Make the ChangeSet's user-facing procedure table a mirror of RunState."""

    root = Path(repo_root)
    change_path = _active_change_set_path(root, state.change_set_id)
    if change_path is None:
        return

    text = change_path.read_text(encoding="utf-8")
    rows = {row["id"]: row for row in parse_procedure_stage_rows(text)}
    runtime_rows = runtime_stage_projection(state)
    changed = False
    for stage in PROCEDURE_STAGES:
        runtime = runtime_rows.get(stage.stage_id)
        desired_status = runtime["status"] if runtime else "pending"
        desired_notes = runtime["notes"] if runtime else "-"
        row = rows.get(stage.stage_id)
        if row and row.get("status") == desired_status and row.get("notes") == desired_notes:
            continue
        text = update_changeset_stage_status(
            text,
            stage=stage,
            status=desired_status,
            notes=desired_notes,
        )
        changed = True
    if changed:
        change_path.write_text(text, encoding="utf-8")


def assert_canonical_stage_gate(
    repo_root: Path | str,
    change_set_id: str,
    target_stage_id: str,
    *,
    uc_id: str | None = None,
) -> None:
    """Reject a downstream action until all earlier canonical stages verify."""

    state = load_canonical_change_set_state(repo_root, change_set_id)
    if state is None:
        raise ValueError(
            f"{target_stage_id} is blocked: canonical RunState is missing for {change_set_id}."
        )
    runtime_rows = runtime_stage_projection(state)
    stage_ids = [stage.stage_id for stage in PROCEDURE_STAGES]
    try:
        target_index = stage_ids.index(target_stage_id)
    except ValueError as exc:
        raise ValueError(f"unknown procedure stage: {target_stage_id}") from exc

    incomplete = [
        stage_id
        for stage_id in stage_ids[:target_index]
        if runtime_rows.get(stage_id, {}).get("status") != "verified"
    ]
    if incomplete:
        raise ValueError(
            f"{target_stage_id} is blocked: canonical runtime gates incomplete: "
            + ", ".join(incomplete)
        )


def apply_dashboard_runtime_state_patch() -> None:
    """Install compatibility hooks without changing public UI/CLI commands."""

    if getattr(RunStateStore, _PATCHED_ATTR, False):
        return

    original_save = RunStateStore.save
    setattr(RunStateStore, _ORIGINAL_SAVE_ATTR, original_save)

    def save_with_canonical_projection(self: RunStateStore, state: RunState) -> Path:
        if state.run_id == canonical_run_id(state.change_set_id):
            state = _hydrate_missing_affected_work_items(self.repo_root, state)
            state = replace(
                state,
                decision_results=_drop_resolved_blocked_stage_decisions(
                    state.decision_results,
                    state.artifact_states,
                ),
            )
        path = original_save(self, state)
        if state.run_id == canonical_run_id(state.change_set_id):
            return path
        if _active_change_set_path(self.repo_root, state.change_set_id) is None:
            return path
        _merge_runtime_state_into_canonical(self.repo_root, state)
        return path

    RunStateStore.save = save_with_canonical_projection  # type: ignore[method-assign]
    setattr(RunStateStore, _PATCHED_ATTR, True)

    # Imports are delayed until RunState and procedure-stage modules are fully
    # initialized.  ui_server keeps direct function references, so patch both
    # the originating module and those references.
    from harness_codex.runtime import document_dashboard, harvest_ui, ui_server

    original_snapshot = harvest_ui.save_changeset_harvest_ui

    def save_changeset_harvest_ui_with_runtime_state(
        root: Path | str, change_set_id: str
    ) -> None:
        original_snapshot(root, change_set_id)
        root_path = Path(root)
        session = harvest_ui._load_session(root_path)
        if session is not None:
            sync_change_set_runtime_state(root_path, change_set_id, session)

    harvest_ui.save_changeset_harvest_ui = save_changeset_harvest_ui_with_runtime_state
    ui_server.save_changeset_harvest_ui = save_changeset_harvest_ui_with_runtime_state

    original_projection = document_dashboard._project_workflow_stages

    def project_only_canonical_runtime_state(
        stages, _workflow_state, run_state=None, work_items=None, pull_request=None
    ):
        # Scoped UI state remains available for question/resume UI, but cannot
        # synthesize verified procedure rows.  Only RunState may do that.
        return original_projection(stages, None, run_state, work_items, pull_request)

    document_dashboard._project_workflow_stages = project_only_canonical_runtime_state

    original_start_plan = ui_server.start_plan_writing_changeset

    def start_plan_writing_with_canonical_gate(root, change_set_id, uc_id, *, reset_plan=False):
        assert_canonical_stage_gate(root, change_set_id, "plan-writing", uc_id=uc_id)
        return original_start_plan(root, change_set_id, uc_id, reset_plan=reset_plan)

    ui_server.start_plan_writing_changeset = start_plan_writing_with_canonical_gate

    original_start_implementation = ui_server.start_implementation_changeset

    def start_implementation_with_canonical_gate(root, change_set_id, *, uc_id="", force_verification=False):
        assert_canonical_stage_gate(root, change_set_id, "implementation", uc_id=uc_id)
        return original_start_implementation(
            root,
            change_set_id,
            uc_id=uc_id,
            force_verification=force_verification,
        )

    ui_server.start_implementation_changeset = start_implementation_with_canonical_gate


def _merge_runtime_state_into_canonical(repo_root: Path, incoming: RunState) -> None:
    current = load_canonical_change_set_state(repo_root, incoming.change_set_id)
    state = _build_canonical_state(
        change_set_id=incoming.change_set_id,
        affected_use_cases=_merge_ids(
            current.affected_use_cases if current else (), incoming.affected_use_cases
        ),
        affected_work_items=_merge_ids(
            current.affected_work_items if current else (), incoming.affected_work_items
        ),
        current=current,
        artifacts={item.stage: item for item in incoming.artifact_states},
        incoming=incoming,
    )
    RunStateStore(repo_root).save(state)
    reconcile_change_set_procedure_table(repo_root, state)


def _build_canonical_state(
    *,
    change_set_id: str,
    affected_use_cases: tuple[str, ...],
    affected_work_items: tuple[str, ...],
    current: RunState | None,
    artifacts: dict[str, StageArtifactState],
    incoming: RunState | None = None,
) -> RunState:
    existing_artifacts = {item.stage: item for item in current.artifact_states} if current else {}
    existing_artifacts.update(artifacts)
    ordered_artifacts = _ordered_artifacts(existing_artifacts)
    source = incoming or current
    if source is None:
        return RunState(
            run_id=canonical_run_id(change_set_id),
            change_set_id=change_set_id,
            workflow_name="changeset-runtime-state",
            mode=RunMode.APPLY,
            affected_use_cases=affected_use_cases,
            affected_work_items=affected_work_items,
            status=RunStatus.PENDING,
            artifact_states=ordered_artifacts,
        )
    if not affected_use_cases and source.affected_use_cases:
        affected_use_cases = source.affected_use_cases
    if not affected_work_items and source.affected_work_items:
        affected_work_items = source.affected_work_items
    return RunState(
        run_id=canonical_run_id(change_set_id),
        change_set_id=change_set_id,
        workflow_name="changeset-runtime-state",
        mode=RunMode.APPLY,
        affected_use_cases=affected_use_cases,
        affected_work_items=affected_work_items,
        current_use_case_id=source.current_use_case_id,
        current_work_item_id=source.current_work_item_id,
        current_step_id=source.current_step_id,
        completed_use_cases=_merge_ids_without(
            current.completed_use_cases if current else (),
            source.completed_use_cases,
            source.blocked_use_cases,
        ),
        completed_work_items=_merge_ids_without(
            current.completed_work_items if current else (),
            source.completed_work_items,
            source.blocked_work_items,
        ),
        blocked_use_cases=_merge_ids_without(
            current.blocked_use_cases if current else (),
            source.blocked_use_cases,
            source.completed_use_cases,
        ),
        blocked_work_items=_merge_ids_without(
            current.blocked_work_items if current else (),
            source.blocked_work_items,
            source.completed_work_items,
        ),
        failed_step_id=source.failed_step_id,
        failure_kind=source.failure_kind,
        status=source.status,
        decision_results=_drop_resolved_blocked_stage_decisions(
            source.decision_results,
            ordered_artifacts,
        ),
        use_case_states=source.use_case_states or (current.use_case_states if current else ()),
        work_item_states=source.work_item_states or (current.work_item_states if current else ()),
        artifact_states=ordered_artifacts,
    )


def _dashboard_stage_artifacts(
    root: Path,
    session: dict[str, Any],
    affected_use_cases: tuple[str, ...],
) -> dict[str, StageArtifactState]:
    artifacts: dict[str, StageArtifactState] = {}
    if session.get("requirements_gate_passed"):
        _add_artifact(artifacts, "requirements-definition", root, [Path("docs/design/요구사항.md")])
    if session.get("language_gate_passed"):
        _add_artifact(artifacts, "ubiquitous-language-definition", root, [_UBIQUITOUS_LANGUAGE_PATH])
    if session.get("use_cases_ready"):
        paths = [Path("docs/design/유스케이스.md")]
        for uc_id in affected_use_cases:
            paths.extend(
                [
                    Path("docs/use-cases") / uc_id / "use-case.md",
                    Path("docs/use-cases") / uc_id / "e2e-goal.md",
                ]
            )
        _add_artifact(artifacts, "use-case-definition", root, paths)

    event_state = session.get("event_storming")
    if isinstance(event_state, dict) and event_state.get("complete"):
        uc_ids = tuple(str(item) for item in event_state.get("uc_ids", ()) if str(item))
        _add_artifact(
            artifacts,
            "event-storming",
            root,
            [Path("docs/use-cases") / uc_id / "event-storming.md" for uc_id in uc_ids],
        )

    ddd_state = session.get("ddd_architecture")
    if isinstance(ddd_state, dict) and ddd_state.get("complete"):
        uc_ids = tuple(str(item) for item in ddd_state.get("uc_ids", ()) if str(item))
        paths = [Path("docs/use-cases") / uc_id / "ddd-design.md" for uc_id in uc_ids]
        paths.append(Path("ARCHITECTURE.md"))
        _add_artifact(artifacts, "ddd-architecture-definition", root, paths)
    return artifacts


def _drop_resolved_blocked_stage_decisions(
    decision_results: Any,
    artifacts: tuple[StageArtifactState, ...],
) -> Any:
    """Remove stale blocked decisions for stages with accepted clean artifacts."""

    if not isinstance(decision_results, dict):
        return decision_results
    stage_results = decision_results.get("procedure_stage_results")
    if not isinstance(stage_results, dict) or not stage_results:
        return decision_results

    verified_artifacts = {
        item.stage
        for item in artifacts
        if item.accepted
        and item.dirty_state == ArtifactDirtyState.CLEAN
        and item.downstream_status == ArtifactDirtyState.CLEAN
    }
    if not verified_artifacts:
        return decision_results

    cleaned_stage_results = {}
    changed = False
    for stage_id, result in stage_results.items():
        if (
            stage_id in verified_artifacts
            and isinstance(result, dict)
            and result.get("status") == "blocked"
        ):
            changed = True
            continue
        cleaned_stage_results[stage_id] = result
    if not changed:
        return decision_results

    cleaned = dict(decision_results)
    cleaned["procedure_stage_results"] = cleaned_stage_results
    return cleaned


def _add_artifact(
    artifacts: dict[str, StageArtifactState],
    stage: str,
    root: Path,
    paths: list[Path],
) -> None:
    if not paths or any(not _nonempty_file(root / path) for path in paths):
        return
    artifacts[stage] = StageArtifactState(
        stage=stage,
        path=paths[0],
        checksum=_combined_checksum(root, paths),
        revision=1,
        generated_by="dashboard",
        accepted=True,
        dirty_state=ArtifactDirtyState.CLEAN,
        downstream_status=ArtifactDirtyState.CLEAN,
    )


def _combined_checksum(root: Path, paths: list[Path]) -> str:
    digest = hashlib.sha256()
    for path in paths:
        digest.update(str(path).encode("utf-8"))
        digest.update((root / path).read_bytes())
    return digest.hexdigest()


def _nonempty_file(path: Path) -> bool:
    try:
        return path.is_file() and bool(path.read_text(encoding="utf-8").strip())
    except OSError:
        return False


def _ordered_artifacts(by_stage: dict[str, StageArtifactState]) -> tuple[StageArtifactState, ...]:
    order = {stage.stage_id: index for index, stage in enumerate(PROCEDURE_STAGES)}
    return tuple(sorted(by_stage.values(), key=lambda item: (order.get(item.stage, len(order)), item.stage)))


def _affected_work_items(root: Path, change_path: Path) -> tuple[tuple[str, ...], tuple[str, ...]]:
    change_set = hydrate_change_set_work_items(
        root,
        parse_changeset_markdown(change_path.read_text(encoding="utf-8"), path=change_path),
    )
    ordered = change_set.ordered_work_items()
    if not ordered:
        fallback = _slice_use_case_work_items(root)
        return fallback, fallback
    work_items = tuple(item.work_item_id for item in ordered)
    use_cases = tuple(
        item.work_item_id
        for item in ordered
        if item.work_item_type is WorkItemType.USE_CASE
    )
    return use_cases, work_items


def _slice_use_case_work_items(root: Path) -> tuple[str, ...]:
    slice_root = root / "docs/use-cases"
    if not slice_root.exists():
        return ()
    return tuple(
        path.name
        for path in sorted(slice_root.iterdir())
        if path.is_dir()
        and re.fullmatch(r"UC-\d+", path.name)
        and (path / "use-case.md").exists()
        and (path / "e2e-goal.md").exists()
    )


def _hydrate_missing_affected_work_items(repo_root: Path, state: RunState) -> RunState:
    if state.affected_use_cases and state.affected_work_items:
        return state
    change_path = _active_change_set_path(repo_root, state.change_set_id)
    if change_path is None:
        return state
    affected_use_cases, affected_work_items = _affected_work_items(repo_root, change_path)
    if not affected_use_cases and not affected_work_items:
        return state
    return replace(
        state,
        affected_use_cases=state.affected_use_cases or affected_use_cases,
        affected_work_items=state.affected_work_items or affected_work_items,
    )


def _active_change_set_path(root: Path, change_set_id: str) -> Path | None:
    if not re.fullmatch(r"CHG-[A-Za-z0-9-]+", change_set_id):
        return None
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    return path if path.exists() else None


def _merge_ids(left: tuple[str, ...], right: tuple[str, ...]) -> tuple[str, ...]:
    return tuple(dict.fromkeys((*left, *right)))


def _merge_ids_without(
    left: tuple[str, ...],
    right: tuple[str, ...],
    removals: tuple[str, ...],
) -> tuple[str, ...]:
    remove_set = set(removals)
    return tuple(item for item in _merge_ids(left, right) if item not in remove_set)
