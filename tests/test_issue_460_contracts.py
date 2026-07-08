from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.changes import ChangeSetResolver
from harness_codex.runtime.materialize_execution_scope import materialize_execution_scope
from harness_codex.runtime.verify_work_item import verify_work_item


def test_maintenance_changeset_runtime_ready_without_global_scope_docs(tmp_path: Path) -> None:
    change_set = tmp_path / "docs/changes/active/CHG-001.md"
    change_set.parent.mkdir(parents=True)
    change_set.write_text(
        "\n".join(
            [
                "# CHG-001",
                "",
                "## 1. 메타데이터",
                "",
                "|항목|값|",
                "|---|---|",
                "|ChangeSet ID|CHG-001|",
                "",
                "## 2. 구현 의도",
                "",
                "- 요청 요약: maintenance runtime-ready gate 완화",
                "",
                "## 6. 영향 작업",
                "",
                "|Work Item ID|Type|Name|Impact Type|Slice Path|Status|",
                "|---|---|---|---|---|---|",
                "|BUG-001|maintenance|정렬 버그 수정|update|docs/maintenance/BUG-001|ready|",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (tmp_path / "docs/maintenance/BUG-001").mkdir(parents=True)

    resolver = ChangeSetResolver(tmp_path)
    blocked = resolver.validate_active_change_set(resolver.load(change_set))

    assert blocked is None


def test_materialize_execution_scope_includes_issue_460_contract_fields(tmp_path: Path) -> None:
    change_set = tmp_path / "docs/changes/active/CHG-001.md"
    plan = tmp_path / "docs/plans/active/BUG-001/plan.md"
    change_set.parent.mkdir(parents=True)
    plan.parent.mkdir(parents=True)
    change_set.write_text(
        "\n".join(
            [
                "# CHG-001",
                "",
                "## 1. 메타데이터",
                "",
                "|항목|값|",
                "|---|---|",
                "|ChangeSet ID|CHG-001|",
                "",
                "## 2. 구현 의도",
                "",
                "- 요청 요약: frontier 기반 maintenance 계획",
                "",
                "## 6. 영향 작업",
                "",
                "|Work Item ID|Type|Name|Impact Type|Slice Path|Status|",
                "|---|---|---|---|---|---|",
                "|BUG-001|maintenance|정렬 버그 수정|update|docs/maintenance/BUG-001|ready|",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    plan.write_text(
        "\n".join(
            [
                "# BUG-001 계획",
                "",
                "## Context Discovery",
                "",
                "### Read Frontier",
                "",
                "- `app/service.py`: 실패 stacktrace 상위 frame",
                "",
                "## Write Intent",
                "",
                "- `app/service.py`: 정렬 기준 수정",
                "- `tests/test_service.py`: 회귀 테스트 추가",
                "",
                "## 작업 체크리스트",
                "",
                "- [ ] `app/service.py` 정렬 기준 수정",
                "",
                "## Focused Regression Plan",
                "",
                "- `./venv/bin/python3 -m pytest -q tests/test_service.py`",
                "",
                "## 집중 검증",
                "",
                "- [ ] VERIFY-001 Tests: `./venv/bin/python3 -m pytest -q tests/test_service.py`",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    payload = materialize_execution_scope(
        repo_root=tmp_path,
        change_set_id="CHG-001",
        work_item_id="BUG-001",
        plan_path=Path("docs/plans/active/BUG-001/plan.md"),
        output_path=Path(".harness/runs/run-1/work-items/BUG-001/execution-scope.xml"),
    )

    assert payload["work_item_profile"] == "maintenance"
    assert payload["read_frontier"] == [{"path": "app/service.py", "reason": "`app/service.py`: 실패 stacktrace 상위 frame"}]
    assert payload["write_intent"][0]["path"] == "app/service.py"
    assert payload["verification_plan"] == ["- `./venv/bin/python3 -m pytest -q tests/test_service.py`"]


def test_verify_work_item_blocks_undocumented_actual_changes(tmp_path: Path) -> None:
    (tmp_path / "docs/plans/active/BUG-001").mkdir(parents=True)
    (tmp_path / "docs/maintenance/BUG-001").mkdir(parents=True)
    (tmp_path / ".codex").mkdir()
    (tmp_path / "docs/plans/active/BUG-001/plan.md").write_text(
        "\n".join(
            [
                "# 계획",
                "## 집중 검증",
                "- [ ] VERIFY-001 Tests: `./venv/bin/python3 -m pytest -q tests/test_bug.py`",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (tmp_path / "docs/maintenance/BUG-001/verification-goal.md").write_text("# 검증\n", encoding="utf-8")
    (tmp_path / ".codex/test-gate.yaml").write_text("required: []\n", encoding="utf-8")
    evidence_root = tmp_path / ".harness/runs/run-1/work-items/BUG-001/steps/execute-work-item/evidence"
    evidence_root.mkdir(parents=True)
    for name in ("build.txt", "tests.txt", "e2e.txt", "test-gate.txt", "runtime.txt", "static-analysis.txt"):
        (evidence_root / name).write_text("PASS\n", encoding="utf-8")
    report = tmp_path / ".harness/runs/run-1/work-items/BUG-001/execution-report.json"
    report.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "change_set_id": "CHG-001",
                "work_item_id": "BUG-001",
                "plan_path": "docs/plans/active/BUG-001/plan.md",
                "plan_fingerprint": "sha256:test",
                "status": "completed",
                "completed_tasks": [],
                "remaining_tasks": [],
                "changed_files": ["app/service.py", "tests/test_bug.py"],
                "verification": [
                    {"label": "Build", "status": "PASS", "evidence_path": str(evidence_root / "build.txt").replace(str(tmp_path) + "/", "")},
                    {"label": "Tests", "status": "PASS", "evidence_path": str(evidence_root / "tests.txt").replace(str(tmp_path) + "/", "")},
                    {"label": "E2E 또는 maintenance verification", "status": "PASS", "evidence_path": str(evidence_root / "e2e.txt").replace(str(tmp_path) + "/", "")},
                    {"label": "Test gate", "status": "PASS", "evidence_path": str(evidence_root / "test-gate.txt").replace(str(tmp_path) + "/", "")},
                    {"label": "Runtime server verification", "status": "PASS", "evidence_path": str(evidence_root / "runtime.txt").replace(str(tmp_path) + "/", "")},
                    {"label": "Static analysis", "status": "PASS", "evidence_path": str(evidence_root / "static-analysis.txt").replace(str(tmp_path) + "/", "")},
                ],
                "blockers": [],
                "actual_changes": [
                    {"path": "app/service.py", "action": "modified", "reason": "정렬 기준 수정"}
                ],
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    result = verify_work_item(
        tmp_path,
        change_set_id="CHG-001",
        work_item_id="BUG-001",
        run_id="run-1",
        write_legacy_reports=False,
    )

    assert not result.passed
    assert result.blocker is not None
    assert "diff contract undocumented changed files" in result.blocker
