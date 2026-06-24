from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.structured_verify_work_item import (
    _failure_fingerprint,
    _repair_inputs,
)
from harness_codex.runtime.verify_work_item import (
    WorkItemCommandResult,
    WorkItemVerificationResult,
)


def _failed_command(name: str, command: str) -> WorkItemCommandResult:
    return WorkItemCommandResult(
        name=name,
        command=command,
        source=".codex/test-gate.yaml",
        exit_code=1,
        stdout_path=Path(".harness/runs/run-1/command/stdout.txt"),
        stderr_path=Path(".harness/runs/run-1/command/stderr.txt"),
    )


def test_repair_inputs_keep_failed_commands_and_unmet_obligations() -> None:
    result = WorkItemVerificationResult(
        change_set_id="CHG-20260624-001",
        work_item_id="UC-001",
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
        verification_goal_path=Path("docs/use-cases/UC-001/e2e-goal.md"),
        test_gate_path=Path(".codex/test-gate.yaml"),
        evidence_dir=Path(".harness/runs/run-1/work-items/UC-001/verification"),
        command_results=(_failed_command("auth tests", "python -m pytest tests/auth -q"),),
        missing_obligations=("expired token must be rejected",),
        blocker="verification failed",
    )

    repair_inputs = _repair_inputs(
        result,
        failure_class="implementation_failure",
        evidence=["failed command: python -m pytest tests/auth -q"],
    )

    assert repair_inputs["failed_gates"] == ["auth tests"]
    assert repair_inputs["unmet_obligations"] == ["expired token must be rejected"]
    assert repair_inputs["failed_commands"] == [
        {
            "name": "auth tests",
            "command": "python -m pytest tests/auth -q",
            "source": ".codex/test-gate.yaml",
            "exit_code": 1,
            "stdout_path": ".harness/runs/run-1/command/stdout.txt",
            "stderr_path": ".harness/runs/run-1/command/stderr.txt",
        }
    ]
    assert repair_inputs["repair_brief_path"] == ".harness/runs/run-1/work-items/UC-001/verification/repair-brief.json"


def test_failure_fingerprint_is_stable_when_failed_command_order_changes() -> None:
    first = _failure_fingerprint(
        failure_class="implementation_failure",
        blocker=" verification   failed ",
        unmet_obligations=["token must be rejected", "error message must be shown"],
        failed_commands=[
            {"name": "B", "command": "pytest b", "source": "gate"},
            {"name": "A", "command": "pytest a", "source": "gate"},
        ],
    )
    second = _failure_fingerprint(
        failure_class="implementation_failure",
        blocker="verification failed",
        unmet_obligations=["error message must be shown", "token must be rejected"],
        failed_commands=[
            {"name": "A", "command": "pytest a", "source": "gate"},
            {"name": "B", "command": "pytest b", "source": "gate"},
        ],
    )

    assert first == second
