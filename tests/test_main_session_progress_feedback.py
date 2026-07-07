from pathlib import Path

from harness_codex.runtime import main_session_progress_patch as progress


def test_active_step_event_ignores_completed_steps() -> None:
    active = progress._active_step_event(
        (
            {"event_type": "step.started", "step_id": "plan-work-item"},
            {"event_type": "step.finished", "step_id": "plan-work-item"},
            {"event_type": "step.started", "step_id": "execute-work-item"},
        )
    )

    assert active is not None
    assert active["step_id"] == "execute-work-item"


def test_progress_message_uses_existing_run_event_fields(monkeypatch) -> None:
    monkeypatch.setattr(
        progress,
        "read_run_events",
        lambda _repo_root, _run_id: (
            {
                "event_type": "step.started",
                "change_set_id": "CHG-081",
                "work_item_id": "UC-031",
                "step_id": "verify-work-item",
            },
        ),
    )

    message = progress._progress_message(Path("."), "run-test", 30.9)

    assert message == (
        "진행 중: ChangeSet CHG-081, Work item UC-031, "
        "step=verify-work-item (30초 경과)"
    )
