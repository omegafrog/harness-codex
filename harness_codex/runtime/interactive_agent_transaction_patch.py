"""Record direct interactive agent calls in the shared SQLite step ledger."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path


def apply_interactive_agent_transaction_patch() -> None:
    """Wrap only interactive adapter calls; standard workflow calls use RunnerEngine."""

    import harness_codex.runtime.runner as runner
    from harness_codex.runtime.agent_output_contract_patch import (
        _validate_declared_output_shapes,
    )
    from harness_codex.runtime.models import FailureKind, StepResult, StepStatus
    from harness_codex.runtime.step_transaction_store import StepTransactionStore

    original_run = runner.ConfigurableCliAgentAdapter.run
    if getattr(original_run, "_interactive_agent_transaction_patch", False):
        return

    def run(self, request):
        if not request.step.metadata.get("interactive"):
            return original_run(self, request)

        store = StepTransactionStore(request.context.repo_root, request.context.run_id)
        transaction = store.begin(request.step, request.context)
        try:
            agent_result = original_run(self, request)
        except BaseException as exc:
            store.finish(
                transaction,
                request.step,
                request.context,
                StepResult(
                    step_id=request.step.id,
                    status=StepStatus.FAILED,
                    error=str(exc),
                    failure_kind=FailureKind.IMPLEMENTATION,
                ),
            )
            raise

        outcome, blocker = _interactive_outcome(request.step_dir)
        step_result = _step_result_for_agent(
            request,
            agent_result,
            outcome=outcome,
            blocker=blocker,
            validate_output=_validate_declared_output_shapes,
            step_result_type=StepResult,
            step_status=StepStatus,
            failure_kind=FailureKind,
        )
        final = store.finish(transaction, request.step, request.context, step_result)
        result_path = _write_interactive_result(request.step_dir, final)
        runner._write_response_snapshot(request.context, request.step.id, result_path)

        # A semantic `needs_input` / `blocked` message is a successful provider
        # invocation. Preserve that provider success so harvest_ui can parse the
        # question or blocker, while SQLite and the run-root response record the
        # terminal blocked state.
        return_status = (
            agent_result.status
            if agent_result.status is StepStatus.SUCCEEDED
            and outcome in {"needs_input", "blocked"}
            else final.status
        )
        return_error = agent_result.error if return_status is agent_result.status else final.error
        return runner.AgentRunResult(
            status=return_status,
            exit_code=final.exit_code,
            error=return_error,
            metadata={
                **dict(agent_result.metadata),
                **dict(final.metadata),
                "interactive_outcome": outcome or "provider_result",
                "interactive_ledger_status": final.status.value,
                "interactive_step_transaction_id": transaction.transaction_id,
                "interactive_step_attempt": transaction.attempt,
            },
        )

    run._interactive_agent_transaction_patch = True
    runner.ConfigurableCliAgentAdapter.run = run


def _step_result_for_agent(
    request,
    agent_result,
    *,
    outcome: str,
    blocker: str,
    validate_output,
    step_result_type,
    step_status,
    failure_kind,
):
    if agent_result.status is not step_status.SUCCEEDED:
        return step_result_type(
            step_id=request.step.id,
            status=agent_result.status,
            exit_code=agent_result.exit_code,
            error=agent_result.error,
            failure_kind=(
                failure_kind.IMPLEMENTATION
                if agent_result.status is step_status.FAILED
                else failure_kind.ENVIRONMENT_BLOCKER
                if agent_result.status is step_status.BLOCKED
                else None
            ),
            metadata=dict(agent_result.metadata),
        )
    if outcome in {"needs_input", "blocked"}:
        return step_result_type(
            step_id=request.step.id,
            status=step_status.BLOCKED,
            exit_code=agent_result.exit_code,
            error=blocker or f"interactive agent outcome: {outcome}",
            failure_kind=(
                failure_kind.UNCLEAR_E2E_GOAL
                if outcome == "needs_input"
                else failure_kind.UPSTREAM_DESIGN
            ),
            metadata={**dict(agent_result.metadata), "interactive_outcome": outcome},
        )

    contract_error = validate_output(request.step, request.context.repo_root)
    return step_result_type(
        step_id=request.step.id,
        status=step_status.FAILED if contract_error else step_status.SUCCEEDED,
        exit_code=agent_result.exit_code,
        error=contract_error or agent_result.error,
        failure_kind=failure_kind.IMPLEMENTATION if contract_error else None,
        metadata=dict(agent_result.metadata),
    )


def _interactive_outcome(step_dir: Path) -> tuple[str, str]:
    path = step_dir / "final-message.md"
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return "", ""
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, flags=re.DOTALL)
        if match is None:
            return "", ""
        try:
            payload = json.loads(match.group(0))
        except json.JSONDecodeError:
            return "", ""
    if not isinstance(payload, dict):
        return "", ""
    outcome = str(payload.get("status", "") or "").strip().lower()
    if outcome not in {"needs_input", "blocked"}:
        return "", ""
    return outcome, str(payload.get("blocker", "") or "")


def _write_interactive_result(step_dir: Path, result) -> Path:
    """Expose the adapter outcome without making interactive UI depend on it."""

    payload = {
        "step_id": result.step_id,
        "status": result.status.value,
        "exit_code": result.exit_code,
        "error": result.error,
        "failure_kind": result.failure_kind.value if result.failure_kind else None,
        "metadata": dict(result.metadata),
    }
    path = step_dir / "result.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return path
