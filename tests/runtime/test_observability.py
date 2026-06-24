from __future__ import annotations

import json

from harness_codex.runtime.models import (
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepResult,
    StepStatus,
)
from harness_codex.runtime.observability import (
    ObservedStepRunner,
    read_run_events,
    render_run_metrics,
    summarize_run_events,
)


class _SuccessfulRunner:
    def run(self, step, context):
        return StepResult(
            step_id=step.id,
            status=StepStatus.SUCCEEDED,
            metadata={
                "execution_mode": "fresh",
                "provider": "codex",
                "prompt": "must-not-be-persisted",
                "stderr": "must-not-be-persisted",
            },
        )


def test_observed_step_runner_writes_safe_event_ledger_and_metrics(tmp_path):
    context = RunContext(
        run_id="run-observe",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-observe/work-items/UC-001",
        metadata={
            "change_set_id": "CHG-001",
            "active_work_item_id": "UC-001",
            "active_work_item_type": "use_case",
        },
    )
    step = Step(id="execute-work-item", kind=StepKind.AGENT, name="Execute", agent_id="executor")

    result = ObservedStepRunner(_SuccessfulRunner()).run(step, context)

    assert result.metadata["phase_metrics"]["total_ms"] >= 0
    events = read_run_events(tmp_path, "run-observe")
    assert [event["event_type"] for event in events] == [
        "run.started",
        "step.started",
        "step.finished",
    ]
    finished = events[-1]
    assert finished["change_set_id"] == "CHG-001"
    assert finished["work_item_id"] == "UC-001"
    assert finished["attributes"] == {"execution_mode": "fresh", "provider": "codex"}
    assert "prompt" not in json.dumps(finished, ensure_ascii=False)
    assert "stderr" not in json.dumps(finished, ensure_ascii=False)

    metrics_path = tmp_path / ".harness/runs/run-observe/metrics.json"
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))
    assert metrics["status_counts"] == {"succeeded": 1}
    assert metrics["bottlenecks"][0]["step_id"] == "execute-work-item"
    assert "execute-work-item" in render_run_metrics(metrics)


def test_summarize_run_events_orders_bottlenecks_and_calculates_percentiles():
    metrics = summarize_run_events(
        [
            {
                "event_type": "step.finished",
                "run_id": "run-001",
                "step_id": "fast",
                "step_kind": "validator",
                "status": "succeeded",
                "duration_ms": 10,
            },
            {
                "event_type": "step.finished",
                "run_id": "run-001",
                "step_id": "slow",
                "step_kind": "agent",
                "status": "failed",
                "duration_ms": 100,
            },
            {
                "event_type": "step.finished",
                "run_id": "run-001",
                "step_id": "slow",
                "step_kind": "agent",
                "status": "succeeded",
                "duration_ms": 200,
            },
        ]
    )

    assert metrics["run_id"] == "run-001"
    assert metrics["status_counts"] == {"failed": 1, "succeeded": 2}
    assert metrics["bottlenecks"][0]["step_id"] == "slow"
    assert metrics["bottlenecks"][0]["p50_ms"] == 150.0
    assert metrics["bottlenecks"][0]["p95_ms"] == 195.0
