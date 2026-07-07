import sqlite3
from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepResult, StepStatus
from harness_codex.runtime.step_transaction_store import StepTransactionStore


def _context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-transaction",
        workflow_name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness" / "runs" / "run-transaction" / "work-items" / "UC-001",
        metadata={"change_set_id": "CHG-001", "active_work_item_id": "UC-001"},
    )


def test_step_commit_persists_status_and_artifact_revision(tmp_path: Path) -> None:
    context = _context(tmp_path)
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="write plan",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )
    store = StepTransactionStore(tmp_path, context.run_id)

    transaction = store.begin(step, context)
    output = tmp_path / step.outputs[0]
    output.parent.mkdir(parents=True)
    output.write_text("# Plan\n", encoding="utf-8")
    result = store.finish(
        transaction,
        step,
        context,
        StepResult(step_id=step.id, status=StepStatus.SUCCEEDED),
    )

    assert result.status is StepStatus.SUCCEEDED
    with sqlite3.connect(store.path) as connection:
        state, status = connection.execute(
            "SELECT state, result_status FROM step_transactions"
        ).fetchone()
        revisions = connection.execute(
            """
            SELECT phase, exists_flag
            FROM step_artifacts
            WHERE path = ? AND role = 'output'
            ORDER BY phase
            """,
            (str(step.outputs[0]),),
        ).fetchall()

    assert (state, status) == ("COMMITTED", "succeeded")
    assert revisions == [("after", 1), ("before", 0)]


def test_missing_declared_output_fails_the_step_transaction(tmp_path: Path) -> None:
    context = _context(tmp_path)
    step = Step(
        id="verify-work-item",
        kind=StepKind.VALIDATOR,
        name="verify",
        outputs=(Path(".harness/runs/run-transaction/verification/report.json"),),
    )
    store = StepTransactionStore(tmp_path, context.run_id)

    transaction = store.begin(step, context)
    result = store.finish(
        transaction,
        step,
        context,
        StepResult(step_id=step.id, status=StepStatus.SUCCEEDED),
    )

    assert result.status is StepStatus.FAILED
    assert result.error == "declared step outputs missing: .harness/runs/run-transaction/verification/report.json"
    with sqlite3.connect(store.path) as connection:
        state, status = connection.execute(
            "SELECT state, result_status FROM step_transactions"
        ).fetchone()

    assert (state, status) == ("FAILED", "failed")


def test_next_step_marks_abandoned_running_transaction_interrupted(tmp_path: Path) -> None:
    context = _context(tmp_path)
    step = Step(id="execute-work-item", kind=StepKind.AGENT, name="execute")
    store = StepTransactionStore(tmp_path, context.run_id)

    first = store.begin(step, context)
    second = store.begin(step, context)

    assert second.attempt == first.attempt + 1
    with sqlite3.connect(store.path) as connection:
        states = connection.execute(
            "SELECT state FROM step_transactions ORDER BY attempt"
        ).fetchall()

    assert states == [("INTERRUPTED",), ("RUNNING",)]
