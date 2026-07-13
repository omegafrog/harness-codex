from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from harness_codex.cli import _workflow_source_error
from harness_codex.runtime.models import RunMode
from harness_codex.runtime.state import RunState, RunStateStore
from harness_codex.runtime.workflows import (
    WorkflowSchemaError,
    load_workflow_file,
    load_named_workflow,
    materialized_workflow_hash,
    materialized_workflow_hash_from_file,
    materialized_workflow_manifest,
    validate_workflow_source,
    write_materialized_workflow_manifest,
)


def _workflow_yaml() -> str:
    return """
version: 1
workflow:
  name: source-test
  mode: apply
steps:
  - id: first
    kind: record
"""


def test_workflow_file_records_canonical_source_identity(tmp_path: Path) -> None:
    path = tmp_path / ".harness" / "workflows" / "source-test.yaml"
    path.parent.mkdir(parents=True)
    path.write_text(_workflow_yaml(), encoding="utf-8")

    workflow = load_workflow_file(path)

    assert workflow.source_path == path.resolve()
    assert workflow.source_sha256 == hashlib.sha256(path.read_bytes()).hexdigest()
    validate_workflow_source(workflow)

    path.write_text(_workflow_yaml().replace("first", "changed"), encoding="utf-8")
    with pytest.raises(ValueError, match="hash mismatch"):
        validate_workflow_source(workflow)


def test_named_workflow_rejects_yaml_name_mismatch(tmp_path: Path) -> None:
    path = tmp_path / "requested.yaml"
    path.write_text(_workflow_yaml(), encoding="utf-8")

    with pytest.raises(WorkflowSchemaError, match="workflow name mismatch"):
        load_named_workflow("requested", tmp_path)


def test_changeset_workflow_requires_orchestration_bootstrap_before_maintenance() -> None:
    workflow = load_workflow_file(Path(".harness/workflows/changeset-use-case-workflow.yaml"))

    assert workflow.step_ids()[:2] == ("create-change-set", "create-maintenance-slice")
    bootstrap = workflow.step_by_id("create-change-set")
    assert bootstrap.kind.value == "agent"
    assert bootstrap.agent_id == "maintenance_intake_specialist"
    assert bootstrap.skill_id == "harness-change-set-bootstrap"
    assert bootstrap.metadata["orchestration_owner"] == "workflow_orchestrator"

    maintenance = workflow.step_by_id("create-maintenance-slice")
    assert maintenance.agent_id == "maintenance_intake_specialist"
    assert maintenance.needs[0].step_id == "create-change-set"
    assert maintenance.needs[0].allowed_outcomes == ("succeeded", "skipped")
    assert tuple(str(path) for path in maintenance.outputs) == (
        "docs/maintenance/<MAINT-ID>/index.md",
        "docs/maintenance/<MAINT-ID>/scope.md",
        "docs/maintenance/<MAINT-ID>/change-intent.md",
        "docs/maintenance/<MAINT-ID>/maintenance-spec.md",
        "docs/maintenance/<MAINT-ID>/architecture-impact.md",
        "docs/maintenance/<MAINT-ID>/verification-goal.md",
        "docs/maintenance/<MAINT-ID>/links.md",
    )
    validation = workflow.step_by_id("validate-maintenance-slice")
    assert [dependency.step_id for dependency in validation.needs] == ["create-maintenance-slice"]
    decisions = workflow.step_by_id("maintenance-technical-decisions")
    assert decisions.agent_id == "technical_decisions"
    assert all(path.suffix for step in workflow.steps if step.kind.value == "agent" for path in step.inputs)
    assert workflow.step_by_id("plan-work-item").needs[0].step_id == "maintenance-technical-decisions"
    for step_id in ("plan-work-item", "review-work-item-plan", "execute-work-item"):
        assert workflow.step_by_id(step_id).metadata["handoff_dir"] == ".harness/runs/<RUN-ID>/steps/<STEP-ID>"
    assert workflow.step_by_id("execute-work-item").metadata["verification_observation_budget_sec"] == 90
    assert "--verification-observation-budget-sec 90" in workflow.step_by_id("materialize-execution-scope").command
    review_inputs = workflow.step_by_id("review-work-item-plan").inputs
    planner_inputs = workflow.step_by_id("plan-work-item").inputs
    assert Path(".codex/skills/harness-code-planner/references/plan-template.md") in planner_inputs
    assert Path(".codex/skills/harness-code-planner/references/plan-template.md") in review_inputs
    assert workflow.step_by_id("review-work-item-plan").outputs == (Path(".harness/runs/<RUN-ID>/steps/review-work-item-plan/subagent-result.xml"),)
    assert Path(".codex/test-gate.yaml") not in review_inputs
    assert Path(".codex/test-gate.yaml") not in workflow.step_by_id("verify-work-item").inputs


def test_maintenance_technical_decision_contract_has_real_producer_and_approval_metadata() -> None:
    contract = Path(".harness/contracts/document-contracts.yaml").read_text(encoding="utf-8")
    template = Path(".harness/docs/templates/maintenance/technical-decisions.md").read_text(encoding="utf-8")
    skill = Path(".codex/skills/harness-technical-decisions/SKILL.md").read_text(encoding="utf-8")

    assert "agent: technical_decision_maker" not in contract
    assert "agent: technical_decisions" in contract
    assert "Approval Status" in template
    assert "승인 근거" in template
    assert "approved" in skill and "pending" in skill


def test_materialized_manifest_records_source_and_stable_snapshot_hash(tmp_path: Path) -> None:
    path = tmp_path / "workflow.yaml"
    path.write_text(_workflow_yaml(), encoding="utf-8")
    workflow = load_workflow_file(path)
    manifest_path = tmp_path / ".harness" / "runs" / "run-1" / "materialized.json"

    write_materialized_workflow_manifest(workflow, manifest_path)
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))

    assert payload["source"]["path"] == str(path.resolve())
    assert payload["source"]["sha256"] == workflow.source_sha256
    assert payload["materialized_sha256"] == materialized_workflow_hash(workflow)
    assert materialized_workflow_hash_from_file(manifest_path) == payload["materialized_sha256"]
    assert materialized_workflow_manifest(workflow)["source"] == payload["source"]


def test_run_state_persists_workflow_source_lineage(tmp_path: Path) -> None:
    state = RunState(
        run_id="run-1",
        change_set_id="CHG-1",
        workflow_name="source-test",
        mode=RunMode.APPLY,
        workflow_source_path=tmp_path / "workflow.yaml",
        workflow_source_sha256="source-hash",
        materialized_workflow_paths={"WI-1": ".harness/runs/run-1/materialized.json"},
        materialized_workflow_sha256s={"WI-1": "snapshot-hash"},
    )

    store = RunStateStore(tmp_path)
    store.save(state)
    loaded = store.load("run-1")

    assert loaded.workflow_source_path == state.workflow_source_path
    assert loaded.workflow_source_sha256 == "source-hash"
    assert loaded.materialized_workflow_paths == state.materialized_workflow_paths
    assert loaded.materialized_workflow_sha256s == state.materialized_workflow_sha256s


def test_resume_blocks_when_canonical_source_changes(tmp_path: Path) -> None:
    source = tmp_path / "workflow.yaml"
    source.write_text(_workflow_yaml(), encoding="utf-8")
    workflow = load_workflow_file(source)
    state = RunState(
        run_id="run-1",
        change_set_id="CHG-1",
        workflow_name=workflow.name,
        mode=RunMode.APPLY,
        workflow_source_path=workflow.source_path,
        workflow_source_sha256=workflow.source_sha256,
    )
    source.write_text(_workflow_yaml().replace("first", "changed"), encoding="utf-8")

    assert "workflow source hash mismatch" in (_workflow_source_error(tmp_path, state) or "")
