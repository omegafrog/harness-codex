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
    skill_id: harness-plan-executor
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


def test_default_implementation_workflow_retains_safety_and_delivery_steps() -> None:
    workflow = load_named_workflow("changeset-use-case-workflow")

    assert workflow.name == "changeset-use-case-workflow"
    assert workflow.step_ids() == (
        "load-change-set",
        "plan-work-item",
        "secure-work-item-plan",
        "review-work-item-plan",
        "execute-work-item",
        "verify-work-item",
        "verify-work-item-security",
        "classify-verification-result",
        "remediate-work-item",
        "complete-work-item-plan",
        "create-change-set-pr",
        "complete-change-set",
    )
    assert workflow.step_by_id("plan-work-item").agent_id == "implementation_planner"
    assert workflow.step_by_id("plan-work-item").skill_id == "harness-code-planner"
    assert workflow.step_by_id("secure-work-item-plan").agent_id == "security_plan_reviewer"
    assert workflow.step_by_id("review-work-item-plan").needs == ("secure-work-item-plan",)
    assert workflow.step_by_id("execute-work-item").skill_id == "harness-plan-executor"
    assert workflow.step_by_id("verify-work-item").command == (
        "python3 -m harness_codex.runtime.verify_work_item "
        "--change-set <CHG-ID> --work-item <WORK-ITEM-ID> --run-id <RUN-ID>"
    )
    assert workflow.step_by_id("classify-verification-result").kind == StepKind.DECISION
    assert workflow.step_by_id("remediate-work-item").metadata["loop_target"] == "execute-work-item"
    assert workflow.step_by_id("create-change-set-pr").metadata["run_on_final_work_item_only"] is True
    assert workflow.step_by_id("complete-change-set").needs == ("create-change-set-pr",)
    assert "update-project-wiki" not in workflow.step_ids()


@pytest.mark.parametrize(
    ("text", "message"),
    (
        ("", "must not be empty"),
        (
            """
workflow:
  name: fix-issue
  mode: plan
steps: []
""",
            "version must be 1",
        ),
        (
            """
version: 1
workflow:
  name: fix-issue
  mode: unsafe
steps:
  - id: analyze
    kind: agent
""",
            "workflow.mode",
        ),
        (
            """
version: 1
workflow:
  name: fix-issue
  mode: plan
steps:
  - id: analyze
    kind: unknown
""",
            "steps\\[0\\].kind",
        ),
    ),
)
def test_load_workflow_rejects_invalid_schema(text: str, message: str) -> None:
    with pytest.raises(WorkflowSchemaError, match=message):
        load_workflow_text(text)


def test_load_workflow_rejects_unknown_dependency() -> None:
    text = """
version: 1
workflow:
  name: fix-issue
  mode: plan
steps:
  - id: validate
    kind: validator
    name: Validate
    needs: [missing]
"""

    with pytest.raises(WorkflowSchemaError, match="depends on unknown step"):
        load_workflow_text(text)
