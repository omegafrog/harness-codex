from __future__ import annotations

from pathlib import Path

from harness_codex.orchestration.runtime_context import context


def test_context_exposes_active_changeset_resume_facts(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow_dir = tmp_path / ".harness/workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    active = tmp_path / "docs/changes/active"
    active.mkdir(parents=True)
    (active / "CHG-001.md").write_text("# CHG-001\n\n## 5. 영향 Work Item\n\n|Work Item ID|유형|이름|영향 유형|Slice 경로|상태|\n|---|---|---|---|---|---|\n|`MAINT-001`|maintenance|x|new|`docs/maintenance/MAINT-001/`|planned|\n", encoding="utf-8")
    (tmp_path / "docs/maintenance/MAINT-001").mkdir(parents=True)
    (tmp_path / "docs/plans/active/MAINT-001").mkdir(parents=True)
    (tmp_path / "docs/plans/active/MAINT-001/plan.md").write_text("# plan", encoding="utf-8")

    facts = context(repo_root=tmp_path, run_id="run-1")

    assert facts["run_id"] == "run-1"
    assert facts["active_change_sets"][0]["change_set_id"] == "CHG-001"
    assert facts["dispatchable_resume_steps"] == [{"change_set_id": "CHG-001", "work_item_id": "MAINT-001", "step_id": "review-work-item-plan"}]
