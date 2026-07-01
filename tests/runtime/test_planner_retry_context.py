from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunMode,
    RunStatus,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)


class _RetryContextRunner:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self.contexts: dict[str, list[RunContext]] = {}
        self.verify_attempt = 0

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.calls.append(step.id)
        self.contexts.setdefault(step.id, []).append(context)
        if step.id == "verify-work-item":
            self.verify_attempt += 1
            if self.verify_attempt == 1:
                return StepResult(
                    step_id=step.id,
                    status=StepStatus.FAILED,
                    error="focused test failed",
                    failure_kind=FailureKind.IMPLEMENTATION,
                    metadata={
                        "verification_failure": {
                            "failure_class": "implementation_failure",
                            "owner_stage": "implementation",
                            "recommended_resume_target": "prepare-plan-repair",
                            "evidence": ["verification/report.json"],
                        }
                    },
                )
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def test_planner_receives_runtime_failure_context_after_verifier_retry(tmp_path: Path) -> None:
    workflow = Workflow(
        name="planner-retry-context",
        mode=RunMode.APPLY,
        steps=(
            Step(id="plan-work-item", kind=StepKind.AGENT, name="plan"),
            Step(
                id="execute-work-item",
                kind=StepKind.AGENT,
                name="execute",
                needs=("plan-work-item",),
            ),
            Step(
                id="verify-work-item",
                kind=StepKind.VALIDATOR,
                name="verify",
                needs=("execute-work-item",),
            ),
            Step(
                id="prepare-plan-repair",
                kind=StepKind.RECORD,
                name="repair handoff",
                needs=("verify-work-item",),
                metadata={"loop_target": "plan-work-item"},
            ),
        ),
    )
    context = RunContext(
        run_id="run-planner-retry",
        workflow_name="planner-retry-context",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-planner-retry",
        metadata={"active_work_item_id": "UC-001"},
    )
    runner = _RetryContextRunner()

    result = RunnerEngine(runner).run(workflow, context)

    assert result.status is RunStatus.SUCCEEDED
    assert result.retry_count == 1
    assert runner.calls == [
        "plan-work-item",
        "execute-work-item",
        "verify-work-item",
        "prepare-plan-repair",
        "plan-work-item",
        "execute-work-item",
        "verify-work-item",
    ]
    retry_context = runner.contexts["plan-work-item"][1]
    assert retry_context.metadata["runtime_retry_count"] == 1
    assert retry_context.metadata["runtime_failed_step_id"] == "verify-work-item"
    assert retry_context.metadata["runtime_failure_kind"] == "implementation"
    assert retry_context.metadata["runtime_failure_metadata"]["verification_failure"]["evidence"] == [
        "verification/report.json"
    ]
