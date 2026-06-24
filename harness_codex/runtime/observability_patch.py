"""Attach local-first observability without changing workflow semantics."""

from __future__ import annotations

import time
from dataclasses import replace
from typing import Mapping


def apply_observability_patch() -> None:
    """Instrument RunnerEngine and BasicStepRunner on every normal runtime import.

    Emission and metric projection are intentionally best-effort. A disk or JSON failure
    must never change the workflow result or mask the original runtime exception.
    """

    import harness_codex.runtime.engine as engine_module
    import harness_codex.runtime.runner as runner_module
    from harness_codex.runtime.observability import RunEventWriter, _duration_ms, _write_metrics_safely

    BasicStepRunner = runner_module.BasicStepRunner
    RunnerEngine = engine_module.RunnerEngine

    if not getattr(BasicStepRunner, "_observability_patch_applied", False):
        original_step_run = BasicStepRunner.run

        def observed_step_run(self, step, context):
            writer = RunEventWriter(context.repo_root, context.run_id)
            writer.start_run_if_absent(context)
            writer.emit("step.started", context, step=step)
            started_ns = time.perf_counter_ns()
            try:
                result = original_step_run(self, step, context)
            except BaseException as exc:
                writer.emit(
                    "step.raised",
                    context,
                    step=step,
                    duration_ms=_duration_ms(started_ns),
                    attributes={"exception_type": type(exc).__name__},
                )
                _write_metrics_safely(context.repo_root, context.run_id)
                raise
            duration_ms = _duration_ms(started_ns)
            existing = result.metadata.get("phase_metrics")
            phase_metrics = dict(existing) if isinstance(existing, Mapping) else {}
            phase_metrics["total_ms"] = round(max(duration_ms, 0.0), 3)
            result = replace(
                result,
                metadata={**dict(result.metadata), "phase_metrics": phase_metrics},
            )
            writer.emit("step.finished", context, step=step, result=result, duration_ms=duration_ms)
            _write_metrics_safely(context.repo_root, context.run_id)
            return result

        BasicStepRunner.run = observed_step_run
        BasicStepRunner._observability_patch_applied = True

    if getattr(RunnerEngine, "_observability_patch_applied", False):
        return

    original_workflow_run = RunnerEngine.run

    def observed_workflow_run(self, workflow, context):
        writer = RunEventWriter(context.repo_root, context.run_id)
        writer.start_run_if_absent(context)
        writer.emit("workflow.started", context)
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
        writer.emit("workflow.finished", context, result=result, duration_ms=_duration_ms(started_ns))
        _write_metrics_safely(context.repo_root, context.run_id)
        return result

    RunnerEngine.run = observed_workflow_run
    RunnerEngine._observability_patch_applied = True
