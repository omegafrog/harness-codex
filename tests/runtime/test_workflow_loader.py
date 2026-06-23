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
    assert workflow.step_by_id("plan-work-item").metadata["stage"] == "plan-writing"
    assert workflow.step_by_id("plan-work-item").metadata["prompt_context_profile"] == "plan"
    assert workflow.step_by_id("secure-work-item-plan").agent_id == "security_plan_reviewer"
    assert (
        workflow.step_by_id("secure-work-item-plan").metadata["prompt_context_profile"]
        == "security-review"
    )
    assert workflow.step_by_id("review-work-item-plan").needs == ("secure-work-item-plan",)
    assert workflow.step_by_id("review-work-item-plan").metadata["prompt_context_profile"] == "review"
    assert workflow.step_by_id("execute-work-item").skill_id == "harness-implementation-executor"
    assert workflow.step_by_id("execute-work-item").metadata["stage"] == "implementation"
    assert workflow.step_by_id("execute-work-item").metadata["prompt_context_profile"] == "execution"
    assert (
        workflow.step_by_id("verify-work-item-security").metadata["prompt_context_profile"]
        == "security-verification"
    )
    assert workflow.step_by_id("verify-work-item").command == (
        "python3 -m harness_codex.runtime.structured_verify_work_item "
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
    name: Analyze active plan
""",
            "mode must be one of",
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
    name: Analyze active plan
""",
            "must be one of",
        ),
        (
            """
version: 1
workflow:
  name: fix-issue
  mode: plan
steps:
  - id: analyze
    kind: agent
    name: Analyze active plan
  - id: analyze
    kind: agent
    name: Duplicate ID
""",
            "Duplicate step id",
        ),
        (
            """
version: 1
workflow:
  name: fix-issue
  mode: plan
steps:
  - id: analyze
    kind: agent
    name: Analyze active plan
    needs: [missing]
""",
            "depends on unknown step",
        ),
    ),
)
def test_load_workflow_text_rejects_invalid_workflow(text: str, message: str) -> None:
    with pytest.raises(WorkflowSchemaError, match=message):
        load_workflow_text(text)
