from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.request_routing import classify_initial_request
from harness_codex.runtime.ui_server import start_requirements_changeset


def test_classify_initial_request_routes_bug_issue_to_bug_workflow() -> None:
    route = classify_initial_request("460번 이슈 검토해서 버그 수정해")

    assert route.workflow == "bug"
    assert "460번 이슈" in route.reason


def test_classify_initial_request_keeps_feature_request_in_changeset() -> None:
    route = classify_initial_request("결제 대시보드에 주간 요약 위젯 추가")

    assert route.workflow == "changeset"


def test_start_requirements_changeset_routes_bug_prompt_to_bug_workflow(tmp_path: Path) -> None:
    payload = start_requirements_changeset(tmp_path, "업로드 실패 버그 수정해. 재현 시 500 error 발생")

    assert payload["route"] == "bug"
    assert payload["bug_id"].startswith("BUG-")
    bug_dir = tmp_path / payload["path"]
    assert bug_dir.is_dir()
    assert (bug_dir / "index.xml").is_file()
    assert not (tmp_path / "docs/changes/active").exists()
