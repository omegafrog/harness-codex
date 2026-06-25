"""Compatibility bridge for procedure rows written by existing CLI commands."""

from __future__ import annotations

import re
from dataclasses import replace
from pathlib import Path

from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.procedure_stages import PROCEDURE_STAGES, parse_procedure_stage_rows
from harness_codex.runtime.state import ArtifactDirtyState, RunState, RunStateStore, StageArtifactState

_PATCHED = "_harness_dashboard_runtime_legacy_bridge_applied"


def apply_dashboard_runtime_state_legacy_bridge() -> None:
    """Promote validated legacy table rows before UI/CLI consumers need them."""

    from harness_codex.runtime import dashboard_runtime_state as canonical
    from harness_codex.runtime import document_dashboard

    if getattr(canonical, _PATCHED, False):
        return

    original_assert = canonical.assert_canonical_stage_gate

    def assert_gate_with_migration(repo_root, change_set_id, target_stage_id):
        _hydrate_verified_procedure_rows(Path(repo_root), change_set_id)
        return original_assert(repo_root, change_set_id, target_stage_id)

    canonical.assert_canonical_stage_gate = assert_gate_with_migration

    original_dashboard_state = document_dashboard.document_dashboard_state

    def document_dashboard_state_with_migration(repo_root):
        root = Path(repo_root)
        active = root / "docs/changes/active"
        if active.exists():
            for path in active.glob("CHG-*.md"):
                _hydrate_verified_procedure_rows(root, path.stem)
        return original_dashboard_state(root)

    document_dashboard.document_dashboard_state = document_dashboard_state_with_migration
    setattr(canonical, _PATCHED, True)


def _hydrate_verified_procedure_rows(root: Path, change_set_id: str) -> None:
    if not re.fullmatch(r"CHG-[A-Za-z0-9-]+", change_set_id):
        return
    change_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_path.exists():
        return
    rows = parse_procedure_stage_rows(change_path.read_text(encoding="utf-8"))
    verified = {row["id"] for row in rows if row.get("status") == "verified"}
    if not verified:
        return

    from harness_codex.runtime import dashboard_runtime_state as canonical

    current = canonical.load_canonical_change_set_state(root, change_set_id)
    artifacts = {item.stage: item for item in (current.artifact_states if current else ())}
    changed = False
    for stage in PROCEDURE_STAGES:
        if stage.stage_id not in verified or stage.stage_id in artifacts:
            continue
        path = _existing_stage_output(root, stage.stage_id)
        if path is None:
            continue
        artifacts[stage.stage_id] = StageArtifactState(
            stage=stage.stage_id,
            path=path,
            generated_by="legacy_procedure_table",
            accepted=True,
            dirty_state=ArtifactDirtyState.CLEAN,
            downstream_status=ArtifactDirtyState.CLEAN,
        )
        changed = True
    if not changed:
        return

    state = current or RunState(
        run_id=canonical.canonical_run_id(change_set_id),
        change_set_id=change_set_id,
        workflow_name="changeset-runtime-state",
        mode=RunMode.APPLY,
        affected_use_cases=(),
        affected_work_items=(),
        status=RunStatus.PENDING,
    )
    order = {stage.stage_id: index for index, stage in enumerate(PROCEDURE_STAGES)}
    updated = replace(
        state,
        artifact_states=tuple(
            sorted(artifacts.values(), key=lambda item: (order.get(item.stage, len(order)), item.stage))
        ),
    )
    RunStateStore(root).save(updated)
    canonical.reconcile_change_set_procedure_table(root, updated)


def _existing_stage_output(root: Path, stage_id: str) -> Path | None:
    candidates = {
        "requirements-definition": (Path("docs/design/요구사항.md"),),
        "ubiquitous-language-definition": (Path("context.md"),),
        "use-case-definition": (Path("docs/design/유스케이스.md"),),
        "event-storming": tuple(
            path.relative_to(root)
            for path in sorted((root / "docs/use-cases").glob("UC-*/event-storming.md"))
        ),
        "ddd-architecture-definition": (Path("ARCHITECTURE.md"),),
        "technical-decisions": tuple(
            path.relative_to(root)
            for path in sorted((root / "docs/use-cases").glob("UC-*/technical-decisions.md"))
        ),
        "design-visualization": tuple(
            path.relative_to(root)
            for path in sorted((root / "docs/use-cases").glob("UC-*/class-diagram.md"))
        ),
        "plan-writing": tuple(
            path.relative_to(root)
            for path in sorted((root / "docs/plans/active").glob("*/plan.md"))
            + sorted((root / "docs/plans/completed").glob("*/plan.md"))
        ),
        "implementation": tuple(
            path.relative_to(root)
            for path in sorted((root / "docs/plans/completed").glob("*/plan.md"))
        ),
    }.get(stage_id, ())
    for relative in candidates:
        path = root / relative
        try:
            if path.is_file() and path.read_text(encoding="utf-8").strip():
                return relative
        except OSError:
            continue
    return None
