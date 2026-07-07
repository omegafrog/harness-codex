"""Record direct interactive agent calls in the shared SQLite step ledger."""

from __future__ import annotations

import json
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

        step_result = StepResult(
            step_id=request.step.id,
            status=agent_result.status,
            exit_code=agent_result.exit_code,
            error=agent_result.error,
            failure_kind=(
                FailureKind.IMPLEMENTATION
                if agent_result.status is StepStatus.FAILED
                else FailureKind.ENVIRONMENT_BLOCKER
                if agent_result.status is StepStatus.BLOCKED
                else None
            ),
            metadata=dict(agent_result.metadata),
        )
        if step_result.status is StepStatus.SUCCEEDED:
            contract_error = _validate_declared_output_shapes(
                request.step,
                request.context.repo_root,
            )
            if contract_error:
                step_result = replace(
                    step_result,
                    status=StepStatus.FAILED,
                    error=contract_error,
                    failure_kind=FailureKind.IMPLEMENTATION,
                )
        final = store.finish(transaction, request.step, request.context, step_result)
        _write_interactive_result(request.step_dir, final)
        return runner.AgentRunResult(
            status=final.status,
            exit_code=final.exit_code,
            error=final.error,
            metadata={
                **dict(agent_result.metadata),
                **dict(final.metadata),
                "interactive_step_transaction_id": transaction.transaction_id,
                "interactive_step_attempt": transaction.attempt,
            },
        )

    run._interactive_agent_transaction_patch = True
    runner.ConfigurableCliAgentAdapter.run = run


def _write_interactive_result(step_dir: Path, result) -> None:
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
