from __future__ import annotations

import sqlite3
from pathlib import Path

from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.session_progress import StaticStepProgressReporter, active_step
from harness_codex.runtime.state import RunState
from harness_codex.runtime.xml_state import save_run_state


def test_active_step_reads_xml_step_ledger(tmp_path: Path) -> None:
    save_run_state(
        tmp_path,
        RunState(
            run_id="run-test",
            change_set_id="CHG-081",
            workflow_name="workflow",
            mode=RunMode.APPLY,
            affected_work_items=("UC-031",),
            status=RunStatus.RUNNING,
            decision_results={
                "xml_step_ledger": {
                    "entries": [
                        {
                            "change_set_id": "CHG-081",
                            "work_item_id": "UC-030",
                            "step_id": "plan-work-item",
                            "state": "COMMITTED",
                        },
                        {
                            "change_set_id": "CHG-081",
                            "work_item_id": "UC-031",
                            "step_id": "execute-work-item",
                            "state": "RUNNING",
                        },
                    ]
                }
            },
        ),
    )

    assert active_step(tmp_path, "run-test") == {
        "change_set_id": "CHG-081",
        "work_item_id": "UC-031",
        "step_id": "execute-work-item",
    }


def test_active_step_falls_back_to_sqlite_ledger(tmp_path: Path) -> None:
    database = tmp_path / ".harness" / "runs" / "run-test" / "state.sqlite3"
    database.parent.mkdir(parents=True)
    with sqlite3.connect(database) as connection:
        connection.execute(
            """
            CREATE TABLE step_transactions (
                id INTEGER PRIMARY KEY,
                change_set_id TEXT,
                work_item_id TEXT,
                step_id TEXT,
                state TEXT
            )
            """
        )
        connection.execute(
            """
            INSERT INTO step_transactions(change_set_id, work_item_id, step_id, state)
            VALUES ('CHG-081', 'UC-031', 'verify-work-item', 'RUNNING')
            """
        )
        connection.commit()

    assert active_step(tmp_path, "run-test") == {
        "change_set_id": "CHG-081",
        "work_item_id": "UC-031",
        "step_id": "verify-work-item",
    }


def test_static_step_progress_reports_interactive_agent_turn() -> None:
    messages: list[str] = []
    reporter = StaticStepProgressReporter(
        "CHG-081",
        "UC-031",
        "ddd-run-all-remaining",
        messages.append,
        interval_seconds=0.01,
    )

    with reporter:
        import time

        time.sleep(0.03)

    assert any(
        message.startswith(
            "진행 중: ChangeSet CHG-081, Work item UC-031, step=ddd-run-all-remaining"
        )
        for message in messages
    )
    assert len(messages) == 1
