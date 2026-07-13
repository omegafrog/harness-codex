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
    maintenance = tmp_path / "docs/maintenance/MAINT-001"
    maintenance.mkdir(parents=True)
    for name in ("index.md", "scope.md", "change-intent.md", "maintenance-spec.md", "architecture-impact.md", "verification-goal.md", "links.md"):
        (maintenance / name).write_text("# document", encoding="utf-8")
    (tmp_path / "docs/plans/active/MAINT-001").mkdir(parents=True)
    (tmp_path / "docs/plans/active/MAINT-001/plan.md").write_text("# plan", encoding="utf-8")

    facts = context(repo_root=tmp_path, run_id="run-1")

    assert facts["run_id"] == "run-1"
    assert facts["active_change_sets"][0]["change_set_id"] == "CHG-001"
    assert facts["dispatchable_resume_steps"] == [{"change_set_id": "CHG-001", "work_item_id": "MAINT-001", "step_id": "plan-work-item"}]


def test_empty_maintenance_directory_cannot_resume_to_review(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow_dir = tmp_path / ".harness/workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    active = tmp_path / "docs/changes/active"
    active.mkdir(parents=True)
    (active / "CHG-001.md").write_text("# CHG-001\n\n## 5. 영향 Work Item\n\n|Work Item ID|유형|이름|영향 유형|Slice 경로|상태|\n|---|---|---|---|---|---|\n|`MAINT-001`|maintenance|x|new|`docs/maintenance/MAINT-001/`|planned|\n", encoding="utf-8")
    (tmp_path / "docs/maintenance/MAINT-001").mkdir(parents=True)
    plan = tmp_path / "docs/plans/active/MAINT-001"
    plan.mkdir(parents=True)
    (plan / "plan.md").write_text("# plan", encoding="utf-8")

    facts = context(repo_root=tmp_path, run_id="run-1")

    assert facts["active_change_sets"][0]["work_items"][0]["slice_ready"] is False
    assert facts["dispatchable_resume_steps"] == []


def test_context_exposes_review_finding_producer_facts_without_selecting_route(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow_dir = tmp_path / ".harness/workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    step_dir = tmp_path / ".harness/runs/run-1/steps/review-work-item-plan"
    step_dir.mkdir(parents=True)
    (step_dir / "subagent-result.xml").write_text(
        '<subagent-result><outcome status="blocked"/><review><findings>'
        '<finding severity="blocking" evidenceRef="plan"><message>plan</message></finding>'
        '<finding severity="blocking" evidenceRef="unknown"><message>unknown</message></finding>'
        '</findings></review><evidence>'
        '<item id="plan" path="docs/plans/active/MAINT-001/plan.md"/>'
        '<item id="unknown" path="docs/unknown.md"/>'
        '</evidence></subagent-result>',
        encoding="utf-8",
    )

    facts = context(repo_root=tmp_path, run_id="run-1")

    findings = facts["review_rejections"][0]["findings"]
    assert findings[0]["producer_step"] == "plan-work-item"
    assert findings[1]["producer_step"] is None


def test_context_marks_old_planner_invocation_stale_and_exposes_validator_producer(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow_dir = tmp_path / ".harness/workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    active = tmp_path / "docs/changes/active"
    active.mkdir(parents=True)
    (active / "CHG-001.md").write_text("# CHG-001\n\n## 5. 영향 Work Item\n\n|Work Item ID|유형|이름|영향 유형|Slice 경로|상태|\n|---|---|---|---|---|---|\n|`MAINT-001`|maintenance|x|new|`docs/maintenance/MAINT-001/`|planned|\n", encoding="utf-8")
    maintenance = tmp_path / "docs/maintenance/MAINT-001"
    maintenance.mkdir(parents=True)
    for name in ("index.md", "scope.md", "change-intent.md", "maintenance-spec.md", "architecture-impact.md", "verification-goal.md", "links.md"):
        (maintenance / name).write_text("# document", encoding="utf-8")
    plan = tmp_path / "docs/plans/active/MAINT-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("# plan", encoding="utf-8")
    (tmp_path / ".codex/repository-settings.md").parent.mkdir(parents=True)
    (tmp_path / ".codex/repository-settings.md").write_text("settings", encoding="utf-8")
    template = tmp_path / ".codex/skills/harness-code-planner/references/plan-template.md"
    template.parent.mkdir(parents=True)
    template.write_text("# template", encoding="utf-8")
    step_root = tmp_path / ".harness/runs/run-1/steps"
    planner = step_root / "plan-work-item"
    planner.mkdir(parents=True)
    (planner / "subagent-invocation.xml").write_text('<subagent-invocation><inputs><artifact path="docs/plans/active/MAINT-001/plan.md" sha256="old"/></inputs></subagent-invocation>', encoding="utf-8")
    (planner / "subagent-result.xml").write_text('<subagent-result><outcome status="completed"/></subagent-result>', encoding="utf-8")
    scope = step_root / "materialize-execution-scope"
    scope.mkdir(parents=True)
    (scope / "result.txt").write_text("status=failed\n", encoding="utf-8")
    (scope / "stderr.txt").write_text("plan contract failed", encoding="utf-8")

    facts = context(repo_root=tmp_path, run_id="run-1")

    assert facts["dispatchable_resume_steps"] == [{"change_set_id": "CHG-001", "work_item_id": "MAINT-001", "step_id": "plan-work-item"}]
    assert facts["stale_steps"][0]["step_id"] == "plan-work-item"
    failed = facts["failed_steps"][0]
    assert failed["step_id"] == "materialize-execution-scope"
    assert failed["input_producers"] == ["plan-work-item"]
