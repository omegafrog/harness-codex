from pathlib import Path

from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    ChangeSet,
    PlanningInputScope,
    WorkItemType,
)
from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    RunContext,
    RunMode,
    RunStatus,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.state import (
    ResumeDisposition,
    RunState,
    UseCaseStep,
    decide_resume_target,
)
from harness_codex.runtime.workflows import (
    load_named_workflow,
    materialize_workflow_for_scope,
)


class RecordingRunner:
    def __init__(self) -> None:
        self.ran: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.ran.append(step.id)
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def test_completed_work_item_uses_same_graph_and_runs_finalization(tmp_path: Path) -> None:
    workflow = Workflow(
        name="canonical",
        mode=RunMode.APPLY,
        steps=(
            Step("load", StepKind.RECORD, "load", metadata={"scope": "change_set"}),
            Step("plan", StepKind.AGENT, "plan", needs=("load",), metadata={"scope": "work_item"}),
            Step("execute", StepKind.AGENT, "execute", needs=("plan",), metadata={"scope": "work_item"}),
            Step("wiki", StepKind.AGENT, "wiki", needs=("execute",), metadata={"scope": "change_set"}),
            Step("pr", StepKind.GIT, "pr", needs=("wiki",), metadata={"scope": "change_set"}),
            Step("complete", StepKind.GIT, "complete", needs=("pr",), metadata={"scope": "change_set"}),
        ),
    )
    runner = RecordingRunner()
    result = RunnerEngine(runner).run(
        workflow,
        RunContext(
            run_id="run-372",
            workflow_name=workflow.name,
            mode=RunMode.APPLY,
            repo_root=tmp_path,
            workdir=tmp_path,
            run_dir=tmp_path / ".harness/runs/run-372",
            metadata={"skip_precompleted_work_item_steps": True},
        ),
    )

    assert result.status == RunStatus.SUCCEEDED
    assert runner.ran == ["load", "wiki", "pr", "complete"]
    assert [item.status for item in result.step_results][1:3] == [
        StepStatus.SKIPPED,
        StepStatus.SKIPPED,
    ]


def test_canonical_yaml_preserves_typed_contracts_and_delivery_order() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    ids = workflow.step_ids()
    security = workflow.step_by_id("verify-work-item-security")

    assert ids.index("verify-work-item") < ids.index("verify-work-item-security")
    assert ids.index("verify-work-item-security") < ids.index("complete-work-item-plan")
    assert ids.index("validate-project-wiki") < ids.index("create-change-set-pr")
    assert ids.index("create-change-set-pr") < ids.index("complete-change-set")
    assert security.metadata["inputs_resolved_by"] == "work_item_document_contract"


def test_security_verification_materializes_executor_contract_inputs() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    workflow = load_named_workflow(
        "changeset-use-case-workflow",
        workflows_dir=repo_root / ".harness/workflows",
    )
    change_set = ChangeSet(change_set_id="CHG-372", title="test")
    use_case = AffectedUseCase(
        uc_id="UC-372",
        name="security test",
        impact_type="update",
        slice_path=Path("docs/use-cases/UC-372"),
    )
    scope = PlanningInputScope(
        change_set_path=Path("docs/changes/active/CHG-372.md"),
        use_case=use_case,
        planner_inputs=(Path("docs/use-cases/UC-372/use-case.md"),),
        executor_inputs=(Path("docs/use-cases/UC-372/e2e-goal.md"),),
        e2e_goal_path=Path("docs/use-cases/UC-372/e2e-goal.md"),
        work_item_id="UC-372",
        work_item_type=WorkItemType.USE_CASE,
        plan_path=Path("docs/plans/active/UC-372/plan.md"),
    )

    materialized = materialize_workflow_for_scope(
        workflow,
        change_set,
        scope,
        run_id="run-372",
    )
    security = materialized.step_by_id("verify-work-item-security")

    assert Path("docs/use-cases/UC-372/e2e-goal.md") in security.inputs
    assert all("<RUN-ID>" not in str(path) for path in security.inputs + security.outputs)


def test_finalization_failures_resume_at_finalization_not_work_item() -> None:
    wiki_state = RunState(
        run_id="run-wiki",
        change_set_id="CHG-372",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-372",),
        affected_work_items=("UC-372",),
        failed_step_id="validate-project-wiki",
        status=RunStatus.BLOCKED,
    )
    pr_state = RunState(
        run_id="run-pr",
        change_set_id="CHG-372",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-372",),
        affected_work_items=("UC-372",),
        failed_step_id="create-change-set-pr",
        status=RunStatus.BLOCKED,
    )

    assert decide_resume_target(wiki_state).disposition == ResumeDisposition.RETRY_FINALIZATION
    assert decide_resume_target(wiki_state).step_id == UseCaseStep.DOCUMENTATION
    assert decide_resume_target(pr_state).disposition == ResumeDisposition.RETRY_FINALIZATION
    assert decide_resume_target(pr_state).step_id == UseCaseStep.DELIVERY


def test_legacy_completed_plan_fast_path_is_removed() -> None:
    import harness_codex.cli as cli

    assert not hasattr(cli, "_complete_change_set_from_completed_plans")
