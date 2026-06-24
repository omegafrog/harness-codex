from __future__ import annotations

from harness_codex.runtime.models import RunContext, RunMode, RunResult, RunStatus
from harness_codex.runtime.observability import RunEventWriter, read_run_events


def test_workflow_event_accepts_run_result_without_step_exit_code(tmp_path):
    context = RunContext(
        run_id="run-workflow-result",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-workflow-result",
        metadata={"change_set_id": "CHG-001", "active_work_item_id": "UC-001"},
    )
    result = RunResult(
        run_id=context.run_id,
        status=RunStatus.BLOCKED,
        step_results=(),
        mode=RunMode.APPLY,
        failed_step_id="verify-work-item",
    )

    assert RunEventWriter(tmp_path, context.run_id).emit(
        "workflow.finished",
        context,
        result=result,
        duration_ms=12.5,
    )

    event = read_run_events(tmp_path, context.run_id)[0]
    assert event["status"] == "blocked"
    assert event["failed_step_id"] == "verify-work-item"
    assert "exit_code" not in event
