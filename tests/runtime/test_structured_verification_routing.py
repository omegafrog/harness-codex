from __future__ import annotations

import json
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


class _VerifierRunner:
    def __init__(self, outcomes: list[StepStatus]) -> None:
        self._outcomes = iter(outcomes)
        self.calls: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.calls.append(step.id)
        if step.id == "verify-work-item":
            status = next(self._outcomes)
            if status == StepStatus.FAILED:
                return StepResult(
                    step_id=step.id,
                    status=status,
                    exit_code=1,
                    error="legacy shell exit code",
                    failure_kind=FailureKind.IMPLEMENTATION,
                )
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


class _ExecutorScopeRunner:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.calls.append(step.id)
        if step.id == "execute-work-item":
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error="scope diff blocked unexpected files",
                failure_kind=FailureKind.SCOPE_CONFLICT,
                metadata={
                    "runtime_failure_class": "scope_conflict",
                    "verification_failure": {
                        "failure_class": "scope_conflict",
                        "owner_stage": "changeset",
                        "recommended_resume_target": "change-set-revision",
                        "evidence": ["scope-diff-report.json"],
                    },
                },
            )
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def _workflow() -> Workflow:
    return Workflow(
        name="structured-routing",
        mode=RunMode.APPLY,
        steps=(
            Step(id="verify-work-item", kind=StepKind.VALIDATOR, name="verify"),
            Step(
                id="remediate-work-item",
                kind=StepKind.RECORD,
                name="remediate",
                needs=("verify-work-item",),
                metadata={"loop_target": "verify-work-item"},
            ),
        ),
    )


def _workflow_with_executor_scope() -> Workflow:
    return Workflow(
        name="structured-routing-executor-scope",
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
                needs=("execute-work-item", "verify-work-item"),
                metadata={"loop_target": "plan-work-item"},
            ),
        ),
    )


def _context(tmp_path: Path) -> RunContext:
    return RunContext(
        run_id="run-1",
        workflow_name="structured-routing",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-1",
        metadata={"active_work_item_id": "UC-001"},
    )


def _write_report(tmp_path: Path, failure_class: str, owner: str, resume: str) -> None:
    path = tmp_path / ".harness/runs/run-1/work-items/UC-001/verification/report.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "failure_class": failure_class,
                "owner_stage": owner,
                "recommended_resume_target": resume,
                "evidence": ["stderr: verification/command-01.stderr.txt"],
            }
        ),
        encoding="utf-8",
    )


def test_environment_report_is_classified_and_blocks_without_remediation(tmp_path: Path) -> None:
    _write_report(tmp_path, "environment_blocker", "environment", "environment")
    runner = _VerifierRunner([StepStatus.FAILED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.BLOCKED
    assert result.failure_kind is FailureKind.ENVIRONMENT_BLOCKER
    assert runner.calls == ["verify-work-item"]
    assert result.metadata["decisions"] == ()
    failure = result.step_results[-1].metadata["verification_failure"]
    assert failure["failure_class"] == "environment_blocker"
    assert failure["recommended_resume_target"] == "environment"
    assert failure["owner_stage"] == "environment"


def test_implementation_report_retries_directly_from_verifier_report(tmp_path: Path) -> None:
    _write_report(tmp_path, "implementation_failure", "implementation", "remediate-work-item")
    runner = _VerifierRunner([StepStatus.FAILED, StepStatus.SUCCEEDED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert runner.calls.count("verify-work-item") == 2
    assert runner.calls.count("remediate-work-item") == 1
    decision_path = tmp_path / ".harness/runs/run-1/steps/classify-verification-result/decision.json"
    assert not decision_path.exists()


def test_security_report_returns_through_same_repair_loop(tmp_path: Path) -> None:
    _write_report(tmp_path, "security_review_failure", "security-review", "security-review")
    runner = _VerifierRunner([StepStatus.FAILED, StepStatus.SUCCEEDED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert runner.calls.count("verify-work-item") == 2
    assert not (tmp_path / ".harness/runs/run-1/steps/classify-verification-result/decision.json").exists()
    assert runner.calls.count("remediate-work-item") == 1


def test_scope_conflict_blocks_from_verifier_without_classifier(tmp_path: Path) -> None:
    _write_report(tmp_path, "scope_conflict", "changeset", "change-set-revision")
    runner = _VerifierRunner([StepStatus.FAILED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.BLOCKED
    assert result.failure_kind is FailureKind.SCOPE_CONFLICT
    assert runner.calls == ["verify-work-item"]
    assert result.metadata["decisions"] == ()
    failure = result.step_results[-1].metadata["verification_failure"]
    assert failure["failure_class"] == "scope_conflict"
    assert failure["recommended_resume_target"] == "change-set-revision"


def test_executor_scope_conflict_blocks_without_classifier(tmp_path: Path) -> None:
    runner = _ExecutorScopeRunner()

    result = RunnerEngine(runner).run(_workflow_with_executor_scope(), _context(tmp_path))

    assert result.status is RunStatus.BLOCKED
    assert runner.calls == [
        "plan-work-item",
        "execute-work-item",
        "plan-work-item",
        "execute-work-item",
    ]
    assert result.metadata["decisions"] == ()
    assert result.failed_step_id == "execute-work-item"
