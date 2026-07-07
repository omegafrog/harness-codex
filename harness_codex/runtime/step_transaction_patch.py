"""Install SQLite-backed step transaction handling without changing runner behavior."""

from __future__ import annotations

from harness_codex.runtime.models import RunMode, StepResult, StepStatus
from harness_codex.runtime.runner import StepRunner
from harness_codex.runtime.step_transaction_store import StepTransactionStore


class TransactionalStepRunner:
    """Commit step metadata and artifact facts only after the delegate returns."""

    def __init__(self, delegate: StepRunner) -> None:
        self._delegate = delegate

    def run(self, step, context):
        store = StepTransactionStore(context.repo_root, context.run_id)
        transaction = store.begin(step, context)
        try:
            result = self._delegate.run(step, context)
        except BaseException as exc:
            store.finish(
                transaction,
                step,
                context,
                StepResult(
                    step_id=step.id,
                    status=StepStatus.FAILED,
                    error=f"{type(exc).__name__}: {exc}",
                ),
            )
            raise
        return store.finish(transaction, step, context, result)


def apply_step_transaction_patch() -> None:
    """Decorate execution and terminal engine decisions with SQLite transactions.

    The runner wrapper handles actual executions. Engine decision hooks cover steps
    that are intentionally skipped or policy-blocked before a runner is invoked.
    """

    import harness_codex.runtime.engine as engine_module

    RunnerEngine = engine_module.RunnerEngine
    if getattr(RunnerEngine, "_step_transaction_patch_applied", False):
        return

    original_run = RunnerEngine.run
    original_skip_reason = RunnerEngine._work_item_step_skip_reason
    original_policy_evaluation = RunnerEngine._evaluate_command_policy

    def transactional_workflow_run(self, workflow, context):
        if not isinstance(self._step_runner, TransactionalStepRunner):
            self._step_runner = TransactionalStepRunner(self._step_runner)
        return original_run(self, workflow, context)

    def transactional_skip_reason(self, step, context):
        reason = original_skip_reason(self, step, context)
        if reason is not None and context.mode is RunMode.APPLY:
            _record_terminal_step(step, context, StepStatus.SKIPPED, reason)
        return reason

    def transactional_policy_evaluation(self, step, context):
        decision = original_policy_evaluation(self, step, context)
        if decision is not None and not decision.allowed and context.mode is RunMode.APPLY:
            _record_terminal_step(step, context, StepStatus.BLOCKED, decision.reason)
        return decision

    RunnerEngine.run = transactional_workflow_run
    RunnerEngine._work_item_step_skip_reason = transactional_skip_reason
    RunnerEngine._evaluate_command_policy = transactional_policy_evaluation
    RunnerEngine._step_transaction_patch_applied = True


def _record_terminal_step(step, context, status: StepStatus, error: str) -> None:
    store = StepTransactionStore(context.repo_root, context.run_id)
    transaction = store.begin(step, context)
    store.finish(
        transaction,
        step,
        context,
        StepResult(step_id=step.id, status=status, error=error),
    )
