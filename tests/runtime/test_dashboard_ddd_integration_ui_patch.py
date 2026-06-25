from __future__ import annotations

from pathlib import Path

from harness_codex.runtime import ui_server
from harness_codex.runtime.dashboard_ddd_integration_ui_patch import _patch_dashboard_script


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


def test_ddd_integration_rerun_is_change_set_scoped_without_use_case(tmp_path: Path) -> None:
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

    assert command[-3:] == ["ddd-design-integration", "CHG-001", "--force"]
    assert "--uc" not in command
