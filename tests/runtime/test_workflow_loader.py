from pathlib import Path

import pytest

from harness_codex.runtime import RunMode, StepKind
from harness_codex.runtime.workflows import (
    WorkflowSchemaError,
    load_named_workflow,
    load_workflow_text,
)


VALID_WORKFLOW = """
version: 1
workflow:
  name: fix-issue
  mode: plan
  description: Fix an issue through the harness runtime.
sandbox:
  kind: worktree
steps:
  - id: analyze
    kind: agent
    name: Analyze active plan
    agent_id: implementation_executor
    skill_id: harness-implementation-executor
    inputs:
      - docs/plans/active/plan.md
  - id: validate
    kind: validator
    name: Run tests
    needs: [analyze]
    command: ./gradlew test
    timeout_sec: 300
    outputs:
      - reports/test-result.txt
"""


def test_load_workflow_text_converts_yaml_to_runtime_model() -> None:
    workflow = load_workflow_text(VALID_WORKFLOW)
    assert workflow.name == "fix-issue"
    assert workflow.mode == RunMode.PLAN
    assert workflow.step_ids() == ("analyze", "validate")
    assert workflow.step_by_id("analyze").kind == StepKind.AGENT
    assert workflow.step_by_id("validate").needs == ("analyze",)
    assert workflow.step_by_id("validate").command == "./gradlew test"


def test_load_named_workflow_reads_from_harness_workflows_directory(tmp_path: Path) -> None:
    workflows_dir = tmp_path / ".harness" / "workflows"
    workflows_dir.mkdir(parents=True)
    (workflows_dir / "fix-issue.yaml").write_text(VALID_WORKFLOW, encoding="utf-8")
    workflow = load_named_workflow("fix-issue", workflows_dir=workflows_dir)
    assert workflow.name == "fix-issue"
    assert workflow.step_ids() == ("analyze", "validate")


def test_default_workflows_separate_work_item_safety_from_changeset_delivery() -> None:
    work_item_workflow = load_named_workflow("changeset-use-case-workflow")
    finalization_workflow = load_named_workflow("changeset-finalization-workflow")
    step_ids = work_item_workflow.step_ids()

    assert work_item_workflow.name == "changeset-work-item-workflow"
    assert step_ids[0:5] == (
        "load-change-set",
        "plan-work-item",
        "materialize-security-profile",
        "secure-work-item-plan",
        "review-work-item-plan",
    )
    assert work_item_workflow.step_by_id("materialize-security-profile").kind == StepKind.VALIDATOR
    assert work_item_workflow.step_by_id("secure-work-item-plan").needs == ("materialize-security-profile",)
    assert work_item_workflow.step_by_id("secure-work-item-plan").metadata["prompt_context_profile"] == "review-bundle-minimal"
    assert "materialize-execution-scope" in step_ids
    assert step_ids.index("materialize-execution-scope") < step_ids.index("execute-work-item")
    assert step_ids.index("execute-work-item") < step_ids.index("verify-work-item")
    assert step_ids.index("verify-work-item") < step_ids.index("collect-pre-security-token-metrics")
    assert step_ids.index("collect-pre-security-token-metrics") < step_ids.index("materialize-security-review-bundle")
    assert step_ids.index("materialize-security-review-bundle") < step_ids.index("review-work-item-security")
    assert step_ids.index("review-work-item-security") < step_ids.index("verify-work-item-security")
    assert step_ids.index("verify-work-item-security") < step_ids.index("collect-work-item-token-metrics")
    assert step_ids.index("collect-work-item-token-metrics") < step_ids.index("classify-verification-result")
    assert step_ids[-2:] == ("remediate-work-item", "complete-work-item-plan")

    assert work_item_workflow.step_by_id("plan-work-item").agent_id == "implementation_planner"
    assert work_item_workflow.step_by_id("plan-work-item").skill_id == "harness-code-planner"
    assert work_item_workflow.step_by_id("plan-work-item").metadata["stage"] == "plan-writing"
    assert work_item_workflow.step_by_id("plan-work-item").metadata["prompt_context_profile"] == "plan"
    assert work_item_workflow.step_by_id("secure-work-item-plan").agent_id == "security_plan_reviewer"
    assert work_item_workflow.step_by_id("review-work-item-plan").needs == ("secure-work-item-plan",)
    assert work_item_workflow.step_by_id("review-work-item-plan").metadata["prompt_context_profile"] == "review"
    assert work_item_workflow.step_by_id("materialize-execution-scope").kind == StepKind.VALIDATOR
    assert work_item_workflow.step_by_id("execute-work-item").skill_id == "harness-implementation-executor"
    assert work_item_workflow.step_by_id("execute-work-item").metadata["stage"] == "implementation"
    assert work_item_workflow.step_by_id("execute-work-item").metadata["prompt_context_profile"] == "execution-minimal"
    assert work_item_workflow.step_by_id("execute-work-item").inputs == (
        Path("docs/plans/active/<WORK-ITEM-ID>/plan.md"),
        Path(".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/execution-scope.json"),
    )
    assert work_item_workflow.step_by_id("collect-pre-security-token-metrics").kind == StepKind.VALIDATOR
    assert work_item_workflow.step_by_id("collect-work-item-token-metrics").kind == StepKind.VALIDATOR
    security_review = work_item_workflow.step_by_id("review-work-item-security")
    assert security_review.needs == ("materialize-security-review-bundle",)
    assert security_review.metadata["prompt_context_profile"] == "review-bundle-minimal"
    assert security_review.outputs == ()
    assert security_review.metadata["final_response_contract"] == {
        "channel": "final-message",
        "format": "markdown",
        "output": ".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/security/security-review.md",
        "status_label": "Security Review Status",
        "allowed_statuses": ["approved", "rejected"],
    }
    assert work_item_workflow.step_by_id("verify-work-item-security").kind == StepKind.VALIDATOR
    assert work_item_workflow.step_by_id("verify-work-item-security").command == (
        "python3 -m harness_codex.runtime.materialize_security_review "
        "--source .harness/runs/<RUN-ID>/steps/review-work-item-security/final-message.md "
        "--output .harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/security/security-review.md"
    )
    assert work_item_workflow.step_by_id("verify-work-item").command == (
        "python3 -m harness_codex.runtime.structured_verify_work_item "
        "--change-set <CHG-ID> --work-item <WORK-ITEM-ID> --run-id <RUN-ID>"
    )
    assert work_item_workflow.step_by_id("classify-verification-result").kind == StepKind.DECISION
    assert work_item_workflow.step_by_id("remediate-work-item").metadata["loop_target"] == "execute-work-item"
    assert all(step.metadata["execution_boundary"] == "work_item" for step in work_item_workflow.steps)
    assert "create-change-set-pr" not in step_ids
    assert "complete-change-set" not in step_ids
    assert "update-project-wiki" not in step_ids

    assert finalization_workflow.name == "changeset-finalization-workflow"
    assert finalization_workflow.step_ids() == (
        "verify-all-work-items-completed",
        "create-change-set-pr",
        "complete-change-set",
    )
    assert finalization_workflow.step_by_id("create-change-set-pr").needs == ("verify-all-work-items-completed",)
    assert finalization_workflow.step_by_id("complete-change-set").needs == ("create-change-set-pr",)
    assert all(step.metadata["execution_boundary"] == "changeset_finalization" for step in finalization_workflow.steps)
