"""One-time migration for retired scoped dashboard state formats."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path

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
_UBIQUITOUS_LANGUAGE_PATH = Path("docs/design/ubiquitous-language.md")


def migrate_legacy_dashboard_sessions(repo_root: Path | str) -> tuple[str, ...]:
    """Import old scoped UI and procedure-table state exactly once per startup.

    The migration is intentionally a command-startup concern. It never wraps
    dashboard reads, UI handlers, state saves, or procedure gate functions.
    """

    root = Path(repo_root)
    active = root / "docs/changes/active"
    if not active.exists():
        return ()

    migrated: list[str] = []
    for path in sorted(active.glob("CHG-*.md")):
        change_set_id = path.stem
        if not _valid_change_set_id(change_set_id):
            continue
        before = _load_canonical_state(root, change_set_id)
        _migrate_scoped_ui_session(root, change_set_id)
        _hydrate_verified_procedure_rows(root, change_set_id)
        _respect_explicit_language_gate(root, change_set_id)
        after = _load_canonical_state(root, change_set_id)
        if after is not None and after != before:
            migrated.append(change_set_id)
    return tuple(migrated)


def _canonical_run_id(change_set_id: str) -> str:
    return _CANONICAL_RUN_PREFIX + re.sub(r"[^A-Za-z0-9_.-]+", "-", change_set_id)


def _load_canonical_state(root: Path, change_set_id: str) -> RunState | None:
    try:
        return RunStateStore(root).load(_canonical_run_id(change_set_id))
    except (FileNotFoundError, KeyError, TypeError, ValueError):
        return None


def _migrate_scoped_ui_session(root: Path, change_set_id: str) -> None:
    session_path = root / ".harness/ui/change-sets" / change_set_id / "harvest-session.json"
    change_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not session_path.exists() or not change_path.exists():
        return
    try:
        session = json.loads(session_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    if not isinstance(session, dict):
        return

    rows = {
        row["id"]: row
        for row in parse_procedure_stage_rows(change_path.read_text(encoding="utf-8"))
    }
    current = _load_canonical_state(root, change_set_id)
    artifacts = {item.stage: item for item in (current.artifact_states if current else ())}
    scoped = Path(".harness/ui/change-sets") / change_set_id
    changed = False

    changed |= _add_legacy_artifact(
        artifacts,
        rows,
        "requirements-definition",
        root,
        bool(session.get("requirements_gate_passed")),
        (Path("docs/design/요구사항.md"), scoped / "docs/design/요구사항.md"),
    )
    changed |= _add_legacy_artifact(
        artifacts,
        rows,
        "ubiquitous-language-definition",
        root,
        bool(session.get("language_gate_passed") or session.get("requirements_gate_passed")),
        (
            _UBIQUITOUS_LANGUAGE_PATH,
            scoped / _UBIQUITOUS_LANGUAGE_PATH,
            Path("context.md"),
            scoped / "context.md",
            Path("docs/design/요구사항.md"),
            scoped / "docs/design/요구사항.md",
        ),
    )
    changed |= _add_legacy_artifact(
        artifacts,
        rows,
        "use-case-definition",
        root,
        bool(session.get("use_cases_ready")),
        (scoped / "docs/design/유스케이스.md", Path("docs/design/유스케이스.md")),
    )

    event = session.get("event_storming")
    if isinstance(event, dict) and event.get("complete"):
        changed |= _add_legacy_artifact(
            artifacts,
            rows,
            "event-storming",
            root,
            True,
            tuple(
                scoped / "docs/use-cases" / str(uc_id) / "event-storming.md"
                for uc_id in event.get("uc_ids", ())
            ),
        )

    ddd = session.get("ddd_architecture")
    if isinstance(ddd, dict) and ddd.get("complete"):
        changed |= _add_legacy_artifact(
            artifacts,
            rows,
            "ddd-architecture-definition",
            root,
            True,
            tuple(
                scoped / "docs/use-cases" / str(uc_id) / "ddd-design.md"
                for uc_id in ddd.get("uc_ids", ())
            ),
        )

    if not changed:
        return
    state = current or _empty_state(change_set_id)
    updated = replace(state, artifact_states=_ordered_artifacts(artifacts))
    RunStateStore(root).save(updated)
    _reconcile_canonical_rows(root, updated)


def _hydrate_verified_procedure_rows(root: Path, change_set_id: str) -> None:
    change_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_path.exists():
        return
    rows = parse_procedure_stage_rows(change_path.read_text(encoding="utf-8"))
    verified = {row["id"] for row in rows if row.get("status") == "verified"}
    if not verified:
        return

    current = _load_canonical_state(root, change_set_id)
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

    state = current or _empty_state(change_set_id)
    updated = replace(state, artifact_states=_ordered_artifacts(artifacts))
    RunStateStore(root).save(updated)
    _reconcile_canonical_rows(root, updated)


def _respect_explicit_language_gate(root: Path, change_set_id: str) -> None:
    if _explicit_language_gate(root, change_set_id) is not False:
        return
    state = _load_canonical_state(root, change_set_id)
    if state is None:
        return
    legacy_artifact = next(
        (
            item
            for item in state.artifact_states
            if item.stage == "ubiquitous-language-definition"
            and item.generated_by == "legacy_scoped_ui"
        ),
        None,
    )
    if legacy_artifact is None:
        return
    RunStateStore(root).save(
        replace(
            state,
            artifact_states=tuple(
                item
                for item in state.artifact_states
                if item.stage != "ubiquitous-language-definition"
            ),
        )
    )
    _reset_language_table_row(root, change_set_id)


def _empty_state(change_set_id: str) -> RunState:
    return RunState(
        run_id=_canonical_run_id(change_set_id),
        change_set_id=change_set_id,
        workflow_name="changeset-runtime-state",
        mode=RunMode.APPLY,
        affected_use_cases=(),
        affected_work_items=(),
        status=RunStatus.PENDING,
    )


def _reconcile_canonical_rows(root: Path, state: RunState) -> None:
    change_path = root / "docs/changes/active" / f"{state.change_set_id}.md"
    if not change_path.exists():
        return
    text = change_path.read_text(encoding="utf-8")
    rows = {row["id"]: row for row in parse_procedure_stage_rows(text)}
    runtime_rows = runtime_stage_projection(state)
    for stage in PROCEDURE_STAGES:
        runtime = runtime_rows.get(stage.stage_id)
        row = rows.get(stage.stage_id)
        if runtime is None:
            if row and row.get("status") not in {"", "pending"}:
                continue
            desired_status, desired_notes = "pending", "-"
        else:
            desired_status, desired_notes = runtime["status"], runtime["notes"]
        if row and row.get("status") == desired_status and row.get("notes") == desired_notes:
            continue
        text = update_changeset_stage_status(
            text,
            stage=stage,
            status=desired_status,
            notes=desired_notes,
        )
    change_path.write_text(text, encoding="utf-8")


def _add_legacy_artifact(
    artifacts: dict[str, StageArtifactState],
    rows: dict[str, dict[str, str]],
    stage: str,
    root: Path,
    complete: bool,
    candidates: tuple[Path, ...],
) -> bool:
    if not complete or stage in artifacts:
        return False
    row = rows.get(stage, {})
    if row.get("status") not in {"", "pending"}:
        return False
    path = next((candidate for candidate in candidates if _nonempty(root / candidate)), None)
    if path is None:
        return False
    artifacts[stage] = StageArtifactState(
        stage=stage,
        path=path,
        generated_by="legacy_scoped_ui",
        accepted=True,
        dirty_state=ArtifactDirtyState.CLEAN,
        downstream_status=ArtifactDirtyState.CLEAN,
    )
    return True


def _existing_stage_output(root: Path, stage_id: str) -> Path | None:
    candidates = {
        "requirements-definition": (Path("docs/design/요구사항.md"),),
        "ubiquitous-language-definition": (_UBIQUITOUS_LANGUAGE_PATH, Path("context.md")),
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
    return next((relative for relative in candidates if _nonempty(root / relative)), None)


def _ordered_artifacts(artifacts: dict[str, StageArtifactState]) -> tuple[StageArtifactState, ...]:
    order = {stage.stage_id: index for index, stage in enumerate(PROCEDURE_STAGES)}
    return tuple(
        sorted(artifacts.values(), key=lambda item: (order.get(item.stage, len(order)), item.stage))
    )


def _explicit_language_gate(root: Path, change_set_id: str) -> bool | None:
    session_path = root / ".harness/ui/change-sets" / change_set_id / "harvest-session.json"
    try:
        session = json.loads(session_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(session, dict) or "language_gate_passed" not in session:
        return None
    return bool(session["language_gate_passed"])


def _reset_language_table_row(root: Path, change_set_id: str) -> None:
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not path.exists():
        return
    stage = next(
        item for item in PROCEDURE_STAGES if item.stage_id == "ubiquitous-language-definition"
    )
    text = path.read_text(encoding="utf-8")
    path.write_text(
        update_changeset_stage_status(text, stage=stage, status="pending", notes="-"),
        encoding="utf-8",
    )


def _nonempty(path: Path) -> bool:
    try:
        return path.is_file() and bool(path.read_text(encoding="utf-8").strip())
    except OSError:
        return False


def _valid_change_set_id(change_set_id: str) -> bool:
    return bool(re.fullmatch(r"CHG-[A-Za-z0-9-]+", change_set_id))
