from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.validate_scope_diff import validate_scope_diff


def test_repo_scope_support_manifest_allows_support_files_without_expanding_source_scope(
    tmp_path: Path,
) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(
        "\n".join(
            [
                "# 구현 계획",
                "## 실행 경계",
                "### 수정 허용 경로",
                "- `src/main/java/com/example/uc001/**`",
                "### 수정 금지 경로",
                "- N/A",
                "### 영향받는 기존 파일",
                "- N/A",
                "## 작업 체크리스트",
                "- [ ] TASK-001 `src/main/java/com/example/uc001/Foo.java`: 구현.",
            ]
        ),
        encoding="utf-8",
    )
    support_file = tmp_path / "src/main/resources/ehcache.xml"
    support_file.parent.mkdir(parents=True)
    support_file.write_text("<config/>", encoding="utf-8")
    before: dict[str, dict[str, str | None]] = {}
    after = {
        "src/main/resources/ehcache.xml": {
            "path": "src/main/resources/ehcache.xml",
            "state": "file",
            "sha256": "support",
        },
        "src/other/java/Outside.java": {
            "path": "src/other/java/Outside.java",
            "state": "file",
            "sha256": "source",
        },
    }

    result = validate_scope_diff(
        repo_root=tmp_path,
        run_id="run-1",
        change_set_id="CHG-001",
        work_item_id="UC-001",
        before=before,
        after=after,
        report_path=tmp_path / "scope-report.json",
        context_metadata={"active_plan_path": str(plan.relative_to(tmp_path))},
    )

    report = json.loads((tmp_path / "scope-report.json").read_text(encoding="utf-8"))
    allowed_paths = {row["path"] for row in report["allowed"]}
    blocked_paths = set(result.blocked_files)
    manifest_sources = {
        source
        for row in report["allowed"]
        if row["path"] == "src/main/resources/ehcache.xml"
        for source in row["manifest_sources"]
    }

    assert "src/main/resources/ehcache.xml" in allowed_paths
    assert "src/other/java/Outside.java" in blocked_paths
    assert "repository scope support manifest" in manifest_sources
