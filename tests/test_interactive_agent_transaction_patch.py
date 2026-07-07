import json
from pathlib import Path
from types import SimpleNamespace

from harness_codex.runtime.interactive_agent_transaction_patch import (
    _interactive_outcome,
    _step_result_for_agent,
)
from harness_codex.runtime.models import FailureKind, StepStatus


def _request(tmp_path: Path):
    step = SimpleNamespace(id="ddd")
    context = SimpleNamespace(repo_root=tmp_path)
    return SimpleNamespace(step=step, context=context)


def test_needs_input_is_blocked_in_ledger_without_output_contract_failure(tmp_path: Path) -> None:
    step_dir = tmp_path / "step"
    step_dir.mkdir()
    (step_dir / "final-message.md").write_text(
        json.dumps({"status": "needs_input", "questions": [{"question": "Which policy?"}]}),
        encoding="utf-8",
    )
    outcome, blocker = _interactive_outcome(step_dir)
    agent_result = SimpleNamespace(
        status=StepStatus.SUCCEEDED,
        exit_code=0,
        error=None,
        metadata={},
    )

    result = _step_result_for_agent(
        _request(tmp_path),
        agent_result,
        outcome=outcome,
        blocker=blocker,
        validate_output=lambda *_args: "missing output",
        step_result_type=__import__("harness_codex.runtime.models", fromlist=["StepResult"]).StepResult,
        step_status=StepStatus,
        failure_kind=FailureKind,
    )

    assert result.status is StepStatus.BLOCKED
    assert result.failure_kind is FailureKind.UNCLEAR_E2E_GOAL


def test_complete_requires_output_contract(tmp_path: Path) -> None:
    agent_result = SimpleNamespace(
        status=StepStatus.SUCCEEDED,
        exit_code=0,
        error=None,
        metadata={},
    )

    result = _step_result_for_agent(
        _request(tmp_path),
        agent_result,
        outcome="",
        blocker="",
        validate_output=lambda *_args: "agent output must not be empty: docs/candidate.md",
        step_result_type=__import__("harness_codex.runtime.models", fromlist=["StepResult"]).StepResult,
        step_status=StepStatus,
        failure_kind=FailureKind,
    )

    assert result.status is StepStatus.FAILED
    assert result.failure_kind is FailureKind.IMPLEMENTATION
