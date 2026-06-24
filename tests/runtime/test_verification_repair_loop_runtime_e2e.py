from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    RunContext,
    RunMode,
    RunStatus,
    Step,
    StepKind,
    Workflow,
)
from harness_codex.runtime.runner import BasicStepRunner


def _context(tmp_path: Path) -> RunContext:
    return RunContext(
        run_id="run-repair-e2e",
        workflow_name="repair-loop-e2e",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-repair-e2e/work-items/UC-001",
        metadata={
            "change_set_id": "CHG-20260624-001",
            "active_work_item_id": "UC-001",
            "active_work_item_type": "use_case",
            "active_plan_path": "docs/plans/active/UC-001/plan.md",
        },
    )


def _write_active_plan_and_failure_report(tmp_path: Path) -> None:
    plan_path = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan_path.parent.mkdir(parents=True)
    plan_path.write_text("# UC-001 plan\n\n- [ ] Repair token validation\n", encoding="utf-8")

    report_path = (
        tmp_path
        / ".harness/runs/run-repair-e2e/work-items/UC-001/verification/report.json"
    )
    report_path.parent.mkdir(parents=True)
    report_path.write_text(
        json.dumps(
            {
                "failure_class": "implementation_failure",
                "owner_stage": "implementation",
                "recommended_resume_target": "remediate-work-item",
                "failure_fingerprint": "token-validation-failure",
                "failed_gates": ["focused-token-test"],
                "failed_commands": [
                    {
                        "name": "focused-token-test",
                        "command": "test -f .harness/repaired",
                        "source": "e2e-demo",
                        "exit_code": 1,
                        "stdout_path": ".harness/runs/run-repair-e2e/work-items/UC-001/verification/command-01/stdout.txt",
                        "stderr_path": ".harness/runs/run-repair-e2e/work-items/UC-001/verification/command-01/stderr.txt",
                    }
                ],
                "unmet_obligations": ["token validation must pass"],
                "evidence": ["failed command: test -f .harness/repaired"],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def test_runtime_retries_implementation_after_failed_verification(tmp_path: Path) -> None:
    """Run the real engine loop: execute -> fail verify -> repair -> execute -> pass."""

    _write_active_plan_and_failure_report(tmp_path)
    workflow = Workflow(
        name="repair-loop-e2e",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="execute-work-item",
                kind=StepKind.SHELL,
                name="simulate implementation attempt",
                command=(
                    "if [ -f .harness/retry-started ]; "
                    "then touch .harness/repaired; "
                    "else touch .harness/retry-started; fi"
                ),
            ),
            Step(
                id="verify-work-item",
                kind=StepKind.VALIDATOR,
                name="verify repaired token validation",
                command="test -f .harness/repaired",
                needs=("execute-work-item",),
            ),
            Step(
                id="classify-verification-result",
                kind=StepKind.DECISION,
                name="classify failed verification",
                needs=("verify-work-item",),
            ),
            Step(
                id="remediate-work-item",
                kind=StepKind.RECORD,
                name="record repair handoff",
                needs=("classify-verification-result",),
                outputs=(Path("docs/plans/active/UC-001/plan.md"),),
                metadata={"loop_target": "execute-work-item"},
            ),
        ),
    )

    result = RunnerEngine(BasicStepRunner()).run(workflow, _context(tmp_path))

    assert result.status is RunStatus.SUCCEEDED
    assert result.retry_count == 1
    assert (tmp_path / ".harness/retry-started").is_file()
    assert (tmp_path / ".harness/repaired").is_file()

    step_ids = [step.step_id for step in result.step_results]
    assert step_ids == [
        "execute-work-item",
        "verify-work-item",
        "classify-verification-result",
        "remediate-work-item",
        "execute-work-item",
        "verify-work-item",
        "classify-verification-result",
    ]

    brief_path = (
        tmp_path
        / ".harness/runs/run-repair-e2e/work-items/UC-001/verification/repair-brief.json"
    )
    brief = json.loads(brief_path.read_text(encoding="utf-8"))
    assert brief["repair_attempt"] == 1
    assert brief["failure"]["fingerprint"] == "token-validation-failure"
    assert brief["failure"]["failed_commands"][0]["command"] == "test -f .harness/repaired"

    plan_text = (tmp_path / "docs/plans/active/UC-001/plan.md").read_text(encoding="utf-8")
    assert "## Runtime Remediation" in plan_text
    assert "Repair brief:" in plan_text
