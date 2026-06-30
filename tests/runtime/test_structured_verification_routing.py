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
        self.contexts_by_step_id: dict[str, list[RunContext]] = {}

    def run(self, step: Step, context: RunContext) -> StepResult:
        self.calls.append(step.id)
        self.contexts_by_step_id.setdefault(step.id, []).append(context)
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


def _workflow_with_plan_restart() -> Workflow:
    return Workflow(
        name="structured-routing",
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


def test_environment_report_blocks_without_remediation(tmp_path: Path) -> None:
    _write_report(tmp_path, "environment_blocker", "environment", "environment")
    runner = _VerifierRunner([StepStatus.FAILED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.BLOCKED
    assert result.failure_kind is FailureKind.ENVIRONMENT_BLOCKER
    assert runner.calls == ["verify-work-item"]
    decision = result.metadata["decisions"][-1]
    assert decision["failure_class"] == "environment_blocker"
    assert decision["route"] == "environment"
    assert decision["recommended_resume_target"] == "environment"
    assert decision["owner_stage"] == "environment"
    assert decision["evidence"] == ["stderr: verification/command-01.stderr.txt"]

    decision_path = (
        tmp_path
        / ".harness/runs/run-1/steps/classify-verification-result/decision.json"
    )
    payload = json.loads(decision_path.read_text(encoding="utf-8"))
    assert payload["failure_class"] == "environment_blocker"
    assert payload["decision"] == "ENVIRONMENT_BLOCKER"
    assert payload["route"] == "environment"
    assert payload["recommended_resume_target"] == "environment"
    assert payload["owner_stage"] == "environment"
    assert payload["evidence"] == ["stderr: verification/command-01.stderr.txt"]


def test_implementation_report_retries_only_the_remediation_loop(tmp_path: Path) -> None:
    _write_report(tmp_path, "implementation_failure", "implementation", "remediate-work-item")
    runner = _VerifierRunner([StepStatus.FAILED, StepStatus.SUCCEEDED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert runner.calls.count("verify-work-item") == 2
    assert runner.calls.count("remediate-work-item") == 1


def test_security_report_preserves_security_route_without_implementation_retry(tmp_path: Path) -> None:
    _write_report(tmp_path, "security_review_failure", "security-review", "security-review")
    runner = _VerifierRunner([StepStatus.FAILED])

    result = RunnerEngine(runner).run(_workflow(), _context(tmp_path))

    assert result.status is RunStatus.BLOCKED
    assert result.failure_kind is FailureKind.UNKNOWN
    assert runner.calls == ["verify-work-item"]
    assert result.metadata["decisions"][-1]["decision"] == "SECURITY_REVIEW_FAILURE"
    assert result.metadata["decisions"][-1]["route"] == "security-review"


def test_scope_conflict_report_restarts_planner_with_verifier_evidence(tmp_path: Path) -> None:
    _write_report(
        tmp_path,
        "scope_conflict",
        "changeset",
        "change-set-revision",
    )
    runner = _VerifierRunner([StepStatus.FAILED, StepStatus.SUCCEEDED])

    result = RunnerEngine(runner).run(_workflow_with_plan_restart(), _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert runner.calls == [
        "plan-work-item",
        "execute-work-item",
        "verify-work-item",
        "plan-work-item",
        "execute-work-item",
        "verify-work-item",
    ]
    retry_context = runner.contexts_by_step_id["plan-work-item"][1]
    assert retry_context.metadata["runtime_failed_step_id"] == "verify-work-item"
    assert retry_context.metadata["runtime_failure_kind"] == "scope_conflict"
    assert "verification/command-01.stderr.txt" in retry_context.metadata["runtime_failure_error"]
    assert retry_context.metadata["runtime_failure_metadata"]["verification_failure"]["evidence"] == [
        "stderr: verification/command-01.stderr.txt"
    ]
