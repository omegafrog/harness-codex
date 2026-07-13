from __future__ import annotations

from pathlib import Path
from xml.etree import ElementTree as ET

from harness_codex.orchestration.runtime_dispatch import dispatch
from harness_codex.runtime.subagent_contract import RESULT_NS, write_subagent_result


def test_dispatch_blocks_known_failed_dependency(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow = tmp_path / ".harness/workflows"
    workflow.mkdir(parents=True)
    (workflow / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    step_dir = tmp_path / ".harness/runs/run-1/steps/review-work-item-plan"
    result = ET.Element(f"{{{RESULT_NS}}}subagent-result", {"schemaVersion": "1"})
    ET.SubElement(result, f"{{{RESULT_NS}}}identity", {"runId": "run-1", "stepId": "review-work-item-plan", "attemptId": "1"})
    ET.SubElement(result, f"{{{RESULT_NS}}}delegate", {"agentId": "artifact_reviewer", "skillId": "harness-artifact-reviewer"})
    outcome = ET.SubElement(result, f"{{{RESULT_NS}}}outcome", {"status": "blocked"})
    ET.SubElement(outcome, f"{{{RESULT_NS}}}summary").text = "blocked"
    ET.SubElement(result, f"{{{RESULT_NS}}}artifacts")
    ET.SubElement(result, f"{{{RESULT_NS}}}evidence")
    ET.SubElement(result, f"{{{RESULT_NS}}}changes")
    ET.SubElement(result, f"{{{RESULT_NS}}}blockers")
    write_subagent_result(step_dir / "subagent-result.xml", result)

    status, fact = dispatch(repo_root=tmp_path, run_id="run-1", step_id="materialize-execution-scope", change_set_id="CHG-1", work_item_id="MAINT-1")

    assert status == "blocked"
    assert fact == "unmet_needs:review-work-item-plan"


def test_existing_active_changeset_skips_bootstrap_specialist(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow = tmp_path / ".harness/workflows"
    workflow.mkdir(parents=True)
    (workflow / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    active = tmp_path / "docs/changes/active"
    active.mkdir(parents=True)
    (active / "CHG-001.md").write_text("# ChangeSet", encoding="utf-8")

    status, fact = dispatch(repo_root=tmp_path, run_id="run-1", step_id="create-change-set")

    assert (status, fact) == ("succeeded", "condition_skipped")
    assert (tmp_path / ".harness/runs/run-1/steps/create-change-set/result.txt").read_text(encoding="utf-8") == "status=skipped\n"
