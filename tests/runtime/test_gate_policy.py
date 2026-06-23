from __future__ import annotations

from pathlib import Path

import yaml

from harness_codex.runtime import (
    RunContext,
    RunMode,
    RunnerEngine,
    Step,
    StepKind,
    StepResult,
    Workflow,
)
from harness_codex.runtime.changes.models import ChangeSet, PlanningInputScope, WorkItemType
from harness_codex.runtime.gate_policy import (
    GateRequirement,
    derive_gate_policy,
    parse_impact_tags,
    reconcile_observed_change_gates,
)
from harness_codex.runtime.preflight import run_workflow_preflight
from harness_codex.runtime.workflows.materializer import materialize_workflow_for_scope


class _RecordingRunner:
    def __init__(self) -> None:
        self.executed: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.executed.append(step.id)
        return StepResult(step_id=step.id, status="succeeded")


def test_gate_policy_matrix_fixture() -> None:
    fixture_path = Path(__file__).parents[1] / "fixtures" / "gate-policy-matrix.yaml"
    scenarios = yaml.safe_load(fixture_path.read_text(encoding="utf-8"))["scenarios"]

    for scenario in scenarios:
        policy = derive_gate_policy(
            work_item_id=scenario["id"],
            work_item_type=WorkItemType(scenario["work_item_type"]),
            impact_type=scenario["impact_type"],
            affected_paths=scenario["affected_paths"],
        )
        assert policy.risk_level
        assert policy.impact_contract_valid
        for gate_id, expected in scenario["expected"].items():
            assert policy.decision_for(gate_id).requirement is GateRequirement(expected)


def test_korean_impact_aliases_are_normalized_and_unknown_values_fail_closed() -> None:
    security = derive_gate_policy(
        work_item_id="MAINT-001",
        work_item_type=WorkItemType.MAINTENANCE,
        impact_type="보안, 권한, 코드",
    )
    unknown = derive_gate_policy(
        work_item_id="MAINT-002",
        work_item_type=WorkItemType.MAINTENANCE,
        impact_type="unclassified-impact",
    )

    assert {tag.value for tag in parse_impact_tags("문서, 화면, 보안")} == {
        "documentation",
        "ui",
        "security",
    }
    assert security.decision_for("security-review").requirement is GateRequirement.REQUIRED
    assert unknown.impact_contract_valid is False
    assert unknown.decision_for("impact-contract").requirement is GateRequirement.REQUIRED


def test_actual_document_path_does_not_trigger_security_or_ui_escalation() -> None:
    policy = derive_gate_policy(
        work_item_id="MAINT-003",
        work_item_type=WorkItemType.MAINTENANCE,
        impact_type="documentation",
    )

    escalations = reconcile_observed_change_gates(
        (policy,),
        ("docs/security/guide.md", "docs/ui/guide.md"),
    )

    assert escalations == ()


def test_final_changed_files_escalate_previously_skipped_gates() -> None:
    policy = derive_gate_policy(
        work_item_id="MAINT-003",
        work_item_type=WorkItemType.MAINTENANCE,
        impact_type="documentation",
    )

    escalations = reconcile_observed_change_gates(
        (policy,),
        ("frontend/src/GatePanel.tsx", "src/auth/token_validator.py"),
    )

    assert {escalation.gate_id for escalation in escalations} == {
        "browser-ui",
        "runtime-server",
        "security-review",
        "static-analysis",
        "test-gate",
    }


def test_materialized_document_workflow_removes_skipped_security_step(tmp_path: Path) -> None:
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        use_case=None,
        planner_inputs=(),
        executor_inputs=(),
        e2e_goal_path=None,
        work_item_id="MAINT-001",
        work_item_type=WorkItemType.MAINTENANCE,
        impact_type="documentation",
    )
    change_set = ChangeSet(change_set_id="CHG-001", title="maintenance")
    workflow = Workflow(
        name="policy-test",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="security",
                kind=StepKind.AGENT,
                name="Security review",
                metadata={"gate_id": "security-review", "scope": "work_item"},
            ),
            Step(
                id="execute",
                kind=StepKind.AGENT,
                name="Execute",
                needs=("security",),
            ),
        ),
    )
    materialized = materialize_workflow_for_scope(workflow, change_set, scope, run_id="run-001")
    runner = _RecordingRunner()
    RunnerEngine(runner).run(
        materialized,
        RunContext(
            run_id="run-001",
            workflow_name="policy-test",
            mode=RunMode.APPLY,
            repo_root=tmp_path,
            workdir=tmp_path,
            run_dir=tmp_path / ".harness/runs/run-001",
        ),
    )

    assert tuple(step.id for step in materialized.steps) == ("execute",)
    assert materialized.steps[0].needs == ()
    assert runner.executed == ["execute"]
    assert materialized.metadata["skipped_gates"][0]["gate_id"] == "security-review"


def test_document_only_scope_does_not_block_on_test_gate_environment(tmp_path: Path) -> None:
    affected = tmp_path / "docs/maintenance/MAINT-002/affected-files.md"
    affected.parent.mkdir(parents=True)
    affected.write_text(
        "|path|change type|\n|---|---|\n|`docs/runtime/gates.md`|update|\n",
        encoding="utf-8",
    )
    gate_path = tmp_path / ".codex/test-gate.yaml"
    gate_path.parent.mkdir(parents=True)
    gate_path.write_text("required:\n  - command: missing-project-verifier\n", encoding="utf-8")
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-002.md"),
        use_case=None,
        planner_inputs=(Path("docs/maintenance/MAINT-002/affected-files.md"),),
        executor_inputs=(),
        e2e_goal_path=None,
        work_item_id="MAINT-002",
        work_item_type=WorkItemType.MAINTENANCE,
        impact_type="documentation",
    )

    result = run_workflow_preflight(tmp_path, "CHG-002", (scope,))

    assert result.passed
    baseline = next(check for check in result.checks if check.check_id.startswith("baseline-command:"))
    assert baseline.status == "skipped"
    assert baseline.gate_id == "test-gate"
    assert result.as_dict()["gate_policies"][0]["risk_level"] == "documentation"
