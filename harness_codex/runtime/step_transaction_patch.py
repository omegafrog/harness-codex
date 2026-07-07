"""Install SQLite-backed step transaction handling without changing runner behavior."""

from __future__ import annotations

from dataclasses import replace

from harness_codex.runtime.models import StepResult, StepStatus
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
    """Decorate the active runner at engine execution time.

    This deliberately patches ``RunnerEngine.run`` rather than ``BasicStepRunner.run``
    so rollback, scope, and delivery patches remain in their existing order.
    """

    import harness_codex.runtime.engine as engine_module

    RunnerEngine = engine_module.RunnerEngine
    if getattr(RunnerEngine, "_step_transaction_patch_applied", False):
        return

    original_run = RunnerEngine.run

    def transactional_workflow_run(self, workflow, context):
        if not isinstance(self._step_runner, TransactionalStepRunner):
            self._step_runner = TransactionalStepRunner(self._step_runner)
        return original_run(self, workflow, context)

    RunnerEngine.run = transactional_workflow_run
    RunnerEngine._step_transaction_patch_applied = True
