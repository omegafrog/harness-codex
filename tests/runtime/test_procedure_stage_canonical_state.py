from __future__ import annotations

from pathlib import Path

import pytest

import harness_codex.runtime  # installs runtime state bridges
from harness_codex import cli
from harness_codex.runtime import dashboard_runtime_state as dashboard
from harness_codex.runtime.procedure_stages import (
    procedure_stage,
    render_initial_changeset,
)
from harness_codex.runtime.state import ArtifactDirtyState, RunMode, RunState, RunStateStore, StageArtifactState


def write_changeset(root: Path, change_set_id: str) -> Path:
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title="Canonical state test",
            request_summary="Verify one source of procedure truth.",
        ),
        encoding="utf-8",
    )
    return path


def test_cli_stage_status_is_canonical_and_table_is_only_a_mirror(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-901"
    change_path = write_changeset(tmp_path, change_set_id)

    cli._record_procedure_stage_status(
        tmp_path,
        change_path.relative_to(tmp_path),
        procedure_stage("requirements-definition"),
        "verified",
        "requirements accepted",
    )

    state = dashboard.load_canonical_change_set_state(tmp_path, change_set_id)
    assert state is not None
    assert state.decision_results["procedure_stage_results"]["requirements-definition"]["status"] == "verified"

    # A direct Markdown edit cannot change the state consumed by the runtime.
    text = change_path.read_text(encoding="utf-8")
    change_path.write_text(text.replace("|requirements-definition|", "|requirements-definition|", 1).replace("|verified|", "|blocked|", 1), encoding="utf-8")
    rows = cli._procedure_table_rows_for_change_set(tmp_path, change_set_id)
    requirement = next(row for row in rows if row["id"] == "requirements-definition")
    assert requirement["status"] == "verified"


def test_stale_integration_blocks_downstream_in_the_same_canonical_state(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-902"
    change_path = write_changeset(tmp_path, change_set_id)
    for stage_id in (
        "requirements-definition",
        "ubiquitous-language-definition",
        "use-case-definition",
        "event-storming",
        "ddd-architecture-definition",
        "ddd-design-integration",
    ):
        cli._record_procedure_stage_status(
            tmp_path,
            change_path.relative_to(tmp_path),
            procedure_stage(stage_id),
            "verified",
            "accepted for gate setup",
        )

    with pytest.raises(ValueError, match="canonical runtime gates incomplete"):
        dashboard.assert_canonical_stage_gate(tmp_path, change_set_id, "technical-decisions")

    state = dashboard.load_canonical_change_set_state(tmp_path, change_set_id)
    assert state is not None
    integration = state.decision_results["procedure_stage_results"]["ddd-design-integration"]
    assert integration["status"] == "stale"


def test_verified_artifact_overrides_stale_blocked_procedure_result(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-903"
    change_path = write_changeset(tmp_path, change_set_id)
    state = RunState(
        run_id=dashboard.canonical_run_id(change_set_id),
        change_set_id=change_set_id,
        workflow_name="changeset-runtime-state",
        mode=RunMode.APPLY,
        affected_use_cases=(),
        decision_results={
            "procedure_stage_results": {
                "use-case-definition": {
                    "status": "blocked",
                    "notes": "interactive Grill-Me stage needs user input",
                }
            }
        },
        artifact_states=(
            StageArtifactState(
                stage="use-case-definition",
                path="docs/design/유스케이스.md",
                accepted=True,
                dirty_state=ArtifactDirtyState.CLEAN,
                downstream_status=ArtifactDirtyState.CLEAN,
                revision=1,
            ),
        ),
    )

    RunStateStore(tmp_path).save(state)
    loaded = dashboard.load_canonical_change_set_state(tmp_path, change_set_id)
    assert loaded is not None
    assert "use-case-definition" not in loaded.decision_results.get("procedure_stage_results", {})

    dashboard.reconcile_change_set_procedure_table(tmp_path, loaded)
    rows = cli._procedure_table_rows_for_change_set(tmp_path, change_set_id)
    use_case = next(row for row in rows if row["id"] == "use-case-definition")
    assert use_case["status"] == "verified"

    projection = dashboard.runtime_stage_projection(loaded)
    assert projection["use-case-definition"]["status"] == "verified"
