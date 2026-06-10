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


MINIMAL_WORKFLOW = """
version: 1
workflow:
  name: fix-issue
  mode: plan
sandbox:
  kind: worktree
steps:
  - id: analyze
    kind: agent
    provider: codex
  - id: validate
    kind: validator
    needs: [analyze]
    command: ./gradlew test
    timeout_sec: 300
"""


def test_load_workflow_text_converts_yaml_to_runtime_model() -> None:
    workflow = load_workflow_text(VALID_WORKFLOW)

    assert workflow.name == "fix-issue"
    assert workflow.mode == RunMode.PLAN
    assert workflow.description == "Fix an issue through the harness runtime."
    assert workflow.metadata["version"] == 1
    assert workflow.metadata["sandbox"] == {"kind": "worktree"}

    assert workflow.step_ids() == ("analyze", "validate")

    analyze = workflow.step_by_id("analyze")
    assert analyze.kind == StepKind.AGENT
    assert analyze.agent_id == "implementation_executor"
    assert analyze.skill_id == "harness-plan-executor"
    assert analyze.inputs == (Path("docs/plans/active/plan.md"),)

    validate = workflow.step_by_id("validate")
    assert validate.kind == StepKind.VALIDATOR
    assert validate.needs == ("analyze",)
    assert validate.command == "./gradlew test"
    assert validate.timeout_sec == 300
    assert validate.outputs == (Path("reports/test-result.txt"),)


def test_load_workflow_text_accepts_issue_minimal_schema() -> None:
    workflow = load_workflow_text(MINIMAL_WORKFLOW)

    assert workflow.name == "fix-issue"
    assert workflow.metadata["sandbox"] == {"kind": "worktree"}
    assert workflow.step_ids() == ("analyze", "validate")

    analyze = workflow.step_by_id("analyze")
    assert analyze.name == "analyze"
    assert analyze.kind == StepKind.AGENT
    assert analyze.metadata["provider"] == "codex"

    validate = workflow.step_by_id("validate")
    assert validate.name == "validate"
    assert validate.command == "./gradlew test"


def test_load_named_workflow_reads_from_harness_workflows_directory(
    tmp_path: Path,
) -> None:
    workflows_dir = tmp_path / ".harness" / "workflows"
    workflows_dir.mkdir(parents=True)
    (workflows_dir / "fix-issue.yaml").write_text(MINIMAL_WORKFLOW, encoding="utf-8")

    workflow = load_named_workflow("fix-issue", workflows_dir=workflows_dir)

    assert workflow.name == "fix-issue"
    assert workflow.step_ids() == ("analyze", "validate")


def test_default_changeset_work_item_workflow_loads() -> None:
    workflow = load_named_workflow("changeset-use-case-workflow")

    assert workflow.name == "changeset-use-case-workflow"
    assert workflow.step_by_id("plan-work-item").agent_id == "implementation_planner"
    assert workflow.step_by_id("plan-work-item").skill_id == "harness-code-planner"
    security = workflow.step_by_id("secure-work-item-plan")
    assert security.agent_id == "security_plan_reviewer"
    assert security.skill_id == "harness-security-plan-reviewer"
    assert security.needs == ("plan-work-item",)
    review = workflow.step_by_id("review-work-item-plan")
    assert review.agent_id == "artifact_reviewer"
    assert review.skill_id == "harness-artifact-reviewer"
    assert review.needs == ("secure-work-item-plan",)
    assert review.metadata["review_gate"]["approved_status"] == "approved"
    assert workflow.step_by_id("execute-work-item").skill_id == (
        "harness-plan-executor"
    )
    assert workflow.step_by_id("execute-work-item").needs == ("review-work-item-plan",)
    assert workflow.step_by_id("verify-work-item").command == (
        "python3 -m harness_codex.runtime.verify_work_item "
        "--change-set <CHG-ID> --work-item <WORK-ITEM-ID> --run-id <RUN-ID>"
    )
    decision = workflow.step_by_id("classify-verification-result")
    assert decision.kind == StepKind.DECISION
    assert decision.metadata["classifier"] == "verification_result"
    assert "UNCLEAR_E2E_GOAL" in decision.metadata["failure_kinds"]
    remediation = workflow.step_by_id("remediate-work-item")
    assert remediation.needs == ("classify-verification-result",)
    assert remediation.metadata["loop_target"] == "execute-work-item"
    assert Path("docs/plans/active/<WORK-ITEM-ID>/plan.md") in remediation.outputs


def test_default_harvest_workflow_loads() -> None:
    workflow = load_named_workflow("harvest-workflow")

    assert workflow.name == "harness-harvest-workflow"
    requirements = workflow.step_by_id("harvest-requirements")
    language = workflow.step_by_id("harvest-ubiquitous-language")
    validate_language = workflow.step_by_id("validate-context-language")
    use_cases = workflow.step_by_id("harvest-use-cases")

    assert workflow.step_ids() == (
        "harvest-requirements",
        "harvest-ubiquitous-language",
        "validate-context-language",
        "harvest-use-cases",
    )

    assert requirements.agent_id == "requirements_interviewer"
    assert requirements.skill_id == "harness-requirements"
    assert requirements.outputs == (Path("docs/design/요구사항.md"),)

    assert language.agent_id == "ubiquitous_language_reviewer"
    assert language.skill_id == "harness-ubiquitous-language"
    assert language.needs == ("harvest-requirements",)
    assert language.inputs == (Path("docs/design/요구사항.md"),)
    assert language.outputs == (Path("context.md"),)

    assert validate_language.kind == StepKind.VALIDATOR
    assert validate_language.needs == ("harvest-ubiquitous-language",)
    assert validate_language.command == "python3 -m harness_codex.context_language --repo-root ."
    assert validate_language.inputs == (
        Path("context.md"),
        Path("docs/design/요구사항.md"),
    )

    assert use_cases.agent_id == "harness_usecases"
    assert use_cases.skill_id == "harness-usecases"
    assert use_cases.needs == ("validate-context-language",)
    assert use_cases.inputs == (
        Path("context.md"),
        Path("docs/design/요구사항.md"),
    )
    assert use_cases.outputs == (Path("docs/design/유스케이스.md"), Path("docs/use-cases"))


def test_load_workflow_rejects_empty_document() -> None:
    with pytest.raises(WorkflowSchemaError, match="must not be empty"):
        load_workflow_text("")


def test_load_workflow_rejects_missing_version() -> None:
    text = """
workflow:
  name: fix-issue
  mode: plan
steps:
  - id: analyze
    kind: agent
    name: Analyze
"""

    with pytest.raises(WorkflowSchemaError, match="version must be 1"):
        load_workflow_text(text)


def test_load_workflow_rejects_invalid_mode() -> None:
    text = """
version: 1
workflow:
  name: fix-issue
  mode: unsafe
steps:
  - id: analyze
    kind: agent
    name: Analyze
"""

    with pytest.raises(WorkflowSchemaError, match="workflow.mode"):
        load_workflow_text(text)


def test_load_workflow_rejects_invalid_sandbox_kind() -> None:
    text = """
version: 1
workflow:
  name: fix-issue
  mode: plan
sandbox:
  kind: root
steps:
  - id: analyze
    kind: agent
"""

    with pytest.raises(WorkflowSchemaError, match="sandbox.kind"):
        load_workflow_text(text)


def test_load_workflow_rejects_invalid_step_kind() -> None:
    text = """
version: 1
workflow:
  name: fix-issue
  mode: plan
steps:
  - id: analyze
    kind: unknown
    name: Analyze
"""

    with pytest.raises(WorkflowSchemaError, match="steps\\[0\\].kind"):
        load_workflow_text(text)


def test_load_workflow_rejects_duplicate_step_ids() -> None:
    text = """
version: 1
workflow:
  name: fix-issue
  mode: plan
steps:
  - id: analyze
    kind: agent
    name: Analyze
  - id: analyze
    kind: validator
    name: Analyze again
"""

    with pytest.raises(WorkflowSchemaError, match="Duplicate step id"):
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


def test_load_workflow_rejects_cyclic_dependency() -> None:
    text = """
version: 1
workflow:
  name: fix-issue
  mode: plan
steps:
  - id: a
    kind: agent
    name: A
    needs: [c]
  - id: b
    kind: agent
    name: B
    needs: [a]
  - id: c
    kind: agent
    name: C
    needs: [b]
"""

    with pytest.raises(WorkflowSchemaError, match="cyclic"):
        load_workflow_text(text)


def test_load_workflow_rejects_non_positive_timeout() -> None:
    text = """
version: 1
workflow:
  name: fix-issue
  mode: plan
steps:
  - id: validate
    kind: validator
    name: Validate
    timeout_sec: 0
"""

    with pytest.raises(WorkflowSchemaError, match="timeout_sec"):
        load_workflow_text(text)
