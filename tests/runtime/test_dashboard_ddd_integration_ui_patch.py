from __future__ import annotations

from pathlib import Path

from harness_codex.runtime import dashboard_runtime_state as dashboard
from harness_codex.runtime import ui_server
from harness_codex.runtime.dashboard_ddd_integration_ui_patch import _patch_dashboard_script
from harness_codex.runtime.procedure_stages import render_initial_changeset


def test_dashboard_script_exposes_ddd_integration_between_ddd_and_technical_decisions() -> None:
    source = (
        Path(ui_server.__file__).with_name("dashboard_assets") / "dashboard.js"
    ).read_text(encoding="utf-8")

    patched = _patch_dashboard_script(source)

    assert 'data-stage-tab="dddIntegration"' in patched
    assert "DDD Design Integration" in patched
    assert 'app.stageTab === "dddIntegration"' in patched
    assert 'data-stage-tab="technicalDecisions" ${!dddIntegrationDone || !technicalAvailable ? "disabled" : ""}' in patched
    assert 'data-stage-tab="dddIntegration">Open DDD Design Integration</button>' in patched
    assert 'if (job.stage_id === "ddd-design-integration") return "dddIntegration";' in patched
    assert 'function renderWorkflowRerunPanel(stageId, label, ucId = "", nextAction = "", complete = true)' in patched
    assert 'complete ? "Rerun and verify" : "Run and verify"' in patched
    assert "This stage is not verified yet." in patched
    assert "nextAction,\n    verified,\n  );" in patched
    assert "if (result.job.dashboard) app.state = result.job.dashboard;" in patched


def test_ddd_integration_rerun_is_change_set_scoped_and_uses_apply_mode(tmp_path: Path) -> None:
    change_path = tmp_path / "docs/changes/active/CHG-001.md"
    change_path.parent.mkdir(parents=True)
    change_path.write_text("# CHG-001\n", encoding="utf-8")

    command = ui_server._rerun_design_stage_command(
        tmp_path,
        "CHG-001",
        "ddd-design-integration",
        "",
        uc_id="",
    )

    assert command[-4:] == ["ddd-design-integration", "CHG-001", "--force", "--apply"]
    assert "--uc" not in command


def test_failed_ddd_integration_rerun_blocks_canonical_stage(tmp_path: Path, monkeypatch) -> None:
    change_set_id = "CHG-001"
    change_path = tmp_path / "docs/changes/active" / f"{change_set_id}.md"
    change_path.parent.mkdir(parents=True)
    change_path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title="DDD integration rerun",
            request_summary="Record a failed UI rerun in canonical state.",
        ),
        encoding="utf-8",
    )

    def raise_rerun_failure(*_args, **_kwargs):
        raise ValueError("apply mode failed")

    monkeypatch.setattr(ui_server, "rerun_design_stage", raise_rerun_failure)
    job = {
        "change_set_id": change_set_id,
        "stage_id": "ddd-design-integration",
        "uc_id": "",
        "status": "running",
        "started_at": "",
        "started_at_epoch": 0.0,
        "finished_at": "",
        "finished_at_epoch": 0.0,
        "returncode": None,
        "output": "",
        "error": "",
        "pending_questions": [],
    }

    with ui_server._STAGE_RERUN_JOBS_LOCK:
        ui_server._STAGE_RERUN_JOBS[change_set_id] = job
    try:
        ui_server._run_rerun_design_stage_job(
            tmp_path,
            change_set_id,
            "ddd-design-integration",
            "",
            "",
            [],
            False,
        )

        state = dashboard.load_canonical_change_set_state(tmp_path, change_set_id)
        assert state is not None
        assert state.decision_results["procedure_stage_results"]["ddd-design-integration"] == {
            "status": "blocked",
            "notes": "DDD Design Integration rerun failed: apply mode failed",
        }
        with ui_server._STAGE_RERUN_JOBS_LOCK:
            failed_job = ui_server._STAGE_RERUN_JOBS[change_set_id]
            assert failed_job["status"] == "failed"
            assert failed_job["dashboard"] is not None
    finally:
        with ui_server._STAGE_RERUN_JOBS_LOCK:
            ui_server._STAGE_RERUN_JOBS.pop(change_set_id, None)
