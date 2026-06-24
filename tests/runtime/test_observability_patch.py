from __future__ import annotations

from harness_codex.runtime import BasicStepRunner, RunnerEngine, RunContext, RunMode, Step, StepKind, Workflow
from harness_codex.runtime.models import RunStatus
from harness_codex.runtime.observability import read_run_events


def test_runtime_import_instruments_engine_and_basic_step_runner(tmp_path):
    workflow = Workflow(
        name="observability-smoke",
        mode=RunMode.APPLY,
        steps=(Step(id="decision", kind=StepKind.DECISION, name="Decision"),),
    )
    context = RunContext(
        run_id="run-patched",
        workflow_name=workflow.name,
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-patched",
        metadata={"change_set_id": "CHG-001", "active_work_item_id": "MAINT-001"},
    )

    result = RunnerEngine(BasicStepRunner()).run(workflow, context)

    assert result.status is RunStatus.BLOCKED
    assert [event["event_type"] for event in read_run_events(tmp_path, "run-patched")] == [
        "run.started",
        "workflow.started",
        "step.started",
        "step.finished",
        "workflow.finished",
    ]
    assert (tmp_path / ".harness/runs/run-patched/metrics.json").exists()
