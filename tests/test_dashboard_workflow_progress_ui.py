from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_dashboard_marks_verified_implementation_tab_complete() -> None:
    script = (REPO_ROOT / "harness_codex/runtime/dashboard_assets/dashboard.js").read_text(
        encoding="utf-8"
    )

    assert 'const implementationDone = changeSetStageStatus("implementation") === "verified";' in script
    assert '${implementationDone ? "complete" : implementationAvailable ? "active" : ""}' in script
    assert 'const deliveryAvailable = implementationDone;' in script


def test_dashboard_maps_verified_workflow_stage_to_complete_style() -> None:
    script = (REPO_ROOT / "harness_codex/runtime/dashboard_assets/dashboard.js").read_text(
        encoding="utf-8"
    )
    stylesheet = (REPO_ROOT / "harness_codex/runtime/dashboard_assets/dashboard.css").read_text(
        encoding="utf-8"
    )

    assert "function workflowStageClass(status)" in script
    assert 'if (status === "verified") return "complete";' in script
    assert ".stage.complete" in stylesheet
    assert ".pill.verified" in stylesheet
