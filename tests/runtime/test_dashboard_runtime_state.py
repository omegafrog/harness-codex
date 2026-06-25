from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.dashboard_runtime_state import (
    assert_canonical_stage_gate,
    canonical_run_id,
    load_canonical_change_set_state,
    sync_change_set_runtime_state,
)
from harness_codex.runtime.document_dashboard import _project_workflow_stages
from harness_codex.runtime.procedure_stages import (
    PROCEDURE_STAGES,
    parse_procedure_stage_rows,
    render_initial_changeset,
    update_changeset_stage_status,
)


def _create_change_set(root: Path, change_set_id: str = "CHG-20260625-426") -> Path:
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title="Canonical dashboard runtime state",
            request_summary="Synchronize dashboard stage state.",
        ),
        encoding="utf-8",
    )
    return path


def _write(root: Path, relative: str, content: str = "content") -> None:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def test_dashboard_session_is_persisted_as_canonical_run_state_and_table_mirror(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-426"
    change_path = _create_change_set(tmp_path, change_set_id)
    _write(tmp_path, "docs/design/요구사항.md", "# Requirements\n")
    _write(tmp_path, "context.md", "# Context\n")

    state = sync_change_set_runtime_state(
        tmp_path,
        change_set_id,
        {
            "requirements_gate_passed": True,
            "language_gate_passed": True,
            "use_cases_ready": False,
        },
    )

    assert state.run_id == canonical_run_id(change_set_id)
    loaded = load_canonical_change_set_state(tmp_path, change_set_id)
    assert loaded is not None
    assert {item.stage for item in loaded.artifact_states} == {
        "requirements-definition",
        "ubiquitous-language-definition",
    }

    rows = {row["id"]: row for row in parse_procedure_stage_rows(change_path.read_text(encoding="utf-8"))}
    assert rows["requirements-definition"]["status"] == "verified"
    assert rows["ubiquitous-language-definition"]["status"] == "verified"
    assert rows["use-case-definition"]["status"] == "pending"


def test_scoped_ui_flags_cannot_project_verified_stage_without_run_state() -> None:
    stages = [
        {
            "id": "requirements-definition",
            "procedure": "Requirements",
            "status": "pending",
            "verified_at": "-",
            "notes": "-",
        }
    ]

    projected = _project_workflow_stages(
        stages,
        {"requirements_gate_passed": True},
        None,
    )

    assert projected[0]["status"] == "pending"


def test_plan_gate_requires_canonical_run_state_not_local_ui_flags(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-426"
    _create_change_set(tmp_path, change_set_id)

    with pytest.raises(ValueError, match="canonical RunState is missing"):
        assert_canonical_stage_gate(tmp_path, change_set_id, "plan-writing")


def test_verified_legacy_procedure_row_is_hydrated_before_gate_check(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-426"
    change_path = _create_change_set(tmp_path, change_set_id)
    _write(tmp_path, "docs/design/요구사항.md", "# Requirements\n")

    text = change_path.read_text(encoding="utf-8")
    requirements_stage = next(
        stage for stage in PROCEDURE_STAGES if stage.stage_id == "requirements-definition"
    )
    change_path.write_text(
        update_changeset_stage_status(
            text,
            stage=requirements_stage,
            status="verified",
            notes="verified by legacy CLI",
        ),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="ubiquitous-language-definition"):
        assert_canonical_stage_gate(tmp_path, change_set_id, "plan-writing")

    loaded = load_canonical_change_set_state(tmp_path, change_set_id)
    assert loaded is not None
    assert {item.stage for item in loaded.artifact_states} == {"requirements-definition"}
