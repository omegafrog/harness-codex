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


def _workflow() -> Workflow:
    return Workflow(
        name="structured-routing",
        mode=RunMode.APPLY,
        steps=(
            Step(id="verify-work-item", kind=StepKind.VALIDATOR, name="verify"),
            Step(
                id="classify-verification-result",
                kind=StepKind.DECISION,
                name="classify",
                needs=("verify-work-item",),
                metadata={
                    "on_implementation_failure": "remediate-work-item",
                    "on_security_review_failure": "remediate-work-item",
                    "on_scope_conflict": "change-set-revision",
                },
            ),
            Step(
                id="remediate-work-item",
                kind=StepKind.RECORD,
                name="remediate",
                needs=("classify-verification-result",),
                metadata={"loop_target": "verify-work-item"},
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
    decision = result.metadata["decisions"][-1]
    assert decision["failure_class"] == "environment_blocker"
    assert decision["route"] == "environment"
    assert decision["owner_stage"] == "environment"


def test_implementation_report_retries_only_after_classifier_decision(tmp_path: Path) -> None:
    _write_report(tmp_path, "implementation_failure", "implementation", "remediate-work-item")
    runner = _VerifierRunner([StepStatus.FAILED, StepStatus.SUCCEEDED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert runner.calls.count("verify-work-item") == 2
    assert runner.calls.count("remediate-work-item") == 1
    decision_path = tmp_path / ".harness/runs/run-1/steps/classify-verification-result/decision.json"
    payload = json.loads(decision_path.read_text(encoding="utf-8"))
    assert payload["decision"] == "IMPLEMENTATION_FAILURE"
    assert payload["route"] == "remediate-work-item"


def test_security_report_returns_through_same_repair_loop(tmp_path: Path) -> None:
    _write_report(tmp_path, "security_review_failure", "security-review", "security-review")
    runner = _VerifierRunner([StepStatus.FAILED, StepStatus.SUCCEEDED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert runner.calls.count("verify-work-item") == 2
    decision_path = tmp_path / ".harness/runs/run-1/steps/classify-verification-result/decision.json"
    payload = json.loads(decision_path.read_text(encoding="utf-8"))
    assert payload["decision"] == "SECURITY_REVIEW_FAILURE"
    assert payload["route"] == "remediate-work-item"


def test_scope_conflict_always_reaches_classifier_before_stopping(tmp_path: Path) -> None:
    _write_report(tmp_path, "scope_conflict", "changeset", "change-set-revision")
    runner = _VerifierRunner([StepStatus.FAILED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.BLOCKED
    assert result.failure_kind is FailureKind.SCOPE_CONFLICT
    assert runner.calls == ["verify-work-item"]
    decision = result.metadata["decisions"][-1]
    assert decision["decision"] == "SCOPE_CONFLICT"
    assert decision["route"] == "change-set-revision"
