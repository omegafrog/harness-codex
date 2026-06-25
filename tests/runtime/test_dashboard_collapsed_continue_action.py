from __future__ import annotations

from pathlib import Path


DASHBOARD_HTML = (
    Path(__file__).resolve().parents[2]
    / "harness_codex/runtime/dashboard_assets/dashboard.html"
)


def test_collapsed_workflow_panel_moves_and_restores_the_original_next_stage_action() -> None:
    page = DASHBOARD_HTML.read_text(encoding="utf-8")

    assert 'const actionClass = "grill-panel-collapsed-action";' in page
    assert 'const placeholderClass = "grill-panel-collapsed-action-placeholder";' in page
    assert 'const actionSelector = ".grill-panel-body .next-stage";' in page
    assert "nextAction.before(marker);" in page
    assert "actionContainer.append(nextAction);" in page
    assert "placeholder.replaceWith(movedAction);" in page
    assert "cloneNode" not in page
    assert "outerHTML" not in page
