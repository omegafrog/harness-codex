import sqlite3
from pathlib import Path

from harness_codex.runtime import main_session_progress_patch as progress


def test_active_step_row_reads_latest_running_sqlite_transaction(tmp_path: Path) -> None:
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
        connection.executemany(
            "INSERT INTO step_transactions(change_set_id, work_item_id, step_id, state) VALUES (?, ?, ?, ?)",
            [
                ("CHG-081", "UC-030", "plan-work-item", "COMMITTED"),
                ("CHG-081", "UC-031", "execute-work-item", "RUNNING"),
            ],
        )

    assert progress._active_step_row(tmp_path, "run-test") == {
        "change_set_id": "CHG-081",
        "work_item_id": "UC-031",
        "step_id": "execute-work-item",
    }


def test_progress_message_uses_sqlite_step_state(monkeypatch) -> None:
    monkeypatch.setattr(
        progress,
        "_active_step_row",
        lambda _repo_root, _run_id: {
            "change_set_id": "CHG-081",
            "work_item_id": "UC-031",
            "step_id": "verify-work-item",
        },
    )

    message = progress._progress_message(Path("."), "run-test", 30.9)

    assert message == (
        "진행 중: ChangeSet CHG-081, Work item UC-031, "
        "step=verify-work-item (30초 경과)"
    )
