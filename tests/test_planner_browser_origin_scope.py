from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def test_planner_requires_browser_origin_request_path_for_cross_origin_ui() -> None:
    planner = (REPO_ROOT / ".codex/agents/implementation_planner.toml").read_text(
        encoding="utf-8"
    )

    assert "same-origin proxy or backend CORS configuration" in planner
    assert "frontend origin, methods, and request headers" in planner
