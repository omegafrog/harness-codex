from __future__ import annotations

import pytest

from harness_codex.runtime.dependency_gate import check_step_dependencies
from harness_codex.runtime.models import RunMode, Step, StepDependency, StepKind, StepResult, StepStatus, Workflow
from harness_codex.runtime.workflows.loader import load_workflow_text
from harness_codex.runtime.workflows.schema import WorkflowSchemaError
from harness_codex.orchestration.runtime_dispatch import _step_status


def _workflow(*needs: StepDependency | str) -> Workflow:
    return Workflow(
        name="dependency-test",
        mode=RunMode.APPLY,
        steps=(
            Step(id="execute", kind=StepKind.AGENT, name="execute"),
            Step(id="verify", kind=StepKind.AGENT, name="verify", needs=needs),
            Step(id="repair", kind=StepKind.AGENT, name="repair", needs=(StepDependency("verify", ("failed",)),)),
        ),
    )


@pytest.mark.parametrize("status", (StepStatus.RUNNING, StepStatus.FAILED, StepStatus.BLOCKED, StepStatus.CANCELLED))
def test_default_dependency_requires_succeeded(status: StepStatus) -> None:
    result = check_step_dependencies(
        workflow=_workflow("execute"),
        target_step_id="verify",
        step_results={"execute": StepResult("execute", status)},
    )

    assert not result.allowed
    assert result.violations[0].code == (
        "DEPENDENCY_STILL_RUNNING" if status is StepStatus.RUNNING else "DEPENDENCY_OUTCOME_NOT_ALLOWED"
    )


def test_dependency_allows_declared_blocked_outcome() -> None:
    result = check_step_dependencies(
        workflow=_workflow(StepDependency("execute", ("blocked",))),
        target_step_id="verify",
        step_results={"execute": StepResult("execute", StepStatus.BLOCKED)},
    )

    assert result.allowed


def test_failed_verifier_does_not_change_executor_result_and_allows_repair() -> None:
    workflow = _workflow("execute")
    results = {
        "execute": StepResult("execute", StepStatus.SUCCEEDED),
        "verify": StepResult("verify", StepStatus.FAILED),
    }

    verify = check_step_dependencies(workflow=workflow, target_step_id="verify", step_results=results)
    repair = check_step_dependencies(workflow=workflow, target_step_id="repair", step_results=results)

    assert verify.allowed
    assert repair.allowed
    assert results["execute"].status is StepStatus.SUCCEEDED


def test_missing_target_and_dependency_are_blocked_without_route() -> None:
    workflow = _workflow(StepDependency("missing", ("succeeded",)))
    target_missing = check_step_dependencies(workflow=workflow, target_step_id="absent", step_results={})
    dependency_missing = check_step_dependencies(workflow=workflow, target_step_id="verify", step_results={})

    assert target_missing.violations[0].code == "TARGET_STEP_NOT_FOUND"
    assert dependency_missing.violations[0].code == "DEPENDENCY_STEP_NOT_FOUND"
    assert not hasattr(dependency_missing, "next_step")


def test_workflow_parser_supports_string_and_structured_needs() -> None:
    workflow = load_workflow_text(
        """
version: 1
workflow:
  name: dependency-parser
  mode: apply
steps:
  - id: execute
    kind: agent
  - id: verify
    kind: agent
    needs:
      - execute
  - id: inspect-blocker
    kind: agent
    needs:
      - step: execute
        outcomes: [blocked]
"""
    )

    assert workflow.steps[1].needs == (StepDependency("execute"),)
    assert workflow.steps[2].needs == (StepDependency("execute", ("blocked",)),)


def test_workflow_parser_rejects_unknown_dependency_outcome() -> None:
    with pytest.raises(WorkflowSchemaError, match="unsupported values"):
        load_workflow_text(
            """
version: 1
workflow:
  name: invalid
  mode: apply
steps:
  - id: execute
    kind: agent
  - id: verify
    kind: agent
    needs:
      - step: execute
        outcomes: [owner-stage]
"""
        )


def test_runtime_dispatch_normalizes_completed_xml_outcome(tmp_path) -> None:
    step_dir = tmp_path / "step"
    step_dir.mkdir()
    (step_dir / "subagent-result.xml").write_text('<subagent-result><outcome status="completed"/></subagent-result>', encoding="utf-8")

    assert _step_status(step_dir) == "succeeded"
