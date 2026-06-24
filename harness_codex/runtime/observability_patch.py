"""Attach local-first observability without replacing runtime step behavior."""

from __future__ import annotations

import time


def apply_observability_patch() -> None:
    """Instrument workflow runs and decorate their step runner at execution time.

    The runtime applies several compatibility patches to ``BasicStepRunner`` during
    import. Replacing its ``run`` method captures an unstable point in that patch
    chain and can bypass rollback or completion guards. Decorating the runner only
    while ``RunnerEngine`` executes keeps existing runner semantics intact.
    """

    import harness_codex.runtime.engine as engine_module
    from harness_codex.runtime.observability import (
        ObservedStepRunner,
        RunEventWriter,
        _duration_ms,
        _write_metrics_safely,
    )

    RunnerEngine = engine_module.RunnerEngine
    if getattr(RunnerEngine, "_observability_patch_applied", False):
        return

    original_workflow_run = RunnerEngine.run

    def observed_workflow_run(self, workflow, context):
        writer = RunEventWriter(context.repo_root, context.run_id)
        writer.start_run_if_absent(context)
        writer.emit("workflow.started", context)
        if not isinstance(self._step_runner, ObservedStepRunner):
            self._step_runner = ObservedStepRunner(self._step_runner)
        started_ns = time.perf_counter_ns()
        try:
            result = original_workflow_run(self, workflow, context)
        except BaseException as exc:
            writer.emit(
                "workflow.raised",
                context,
                duration_ms=_duration_ms(started_ns),
                attributes={"exception_type": type(exc).__name__},
            )
            _write_metrics_safely(context.repo_root, context.run_id)
            raise
        writer.emit(
            "workflow.finished",
            context,
            result=result,
            duration_ms=_duration_ms(started_ns),
        )
        _write_metrics_safely(context.repo_root, context.run_id)
        return result

    RunnerEngine.run = observed_workflow_run
    RunnerEngine._observability_patch_applied = True
