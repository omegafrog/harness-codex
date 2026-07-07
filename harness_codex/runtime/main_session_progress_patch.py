"""Render existing run events as periodic main-session progress feedback."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, TimeoutError
from pathlib import Path
from time import monotonic
from typing import Any, Callable, Mapping
from uuid import uuid4

from harness_codex.runtime.observability import read_run_events


PROGRESS_INTERVAL_SECONDS = 30.0


def apply_main_session_progress_feedback_patch() -> None:
    """Reuse the run event ledger to report the active step while a run is executing."""

    import harness_codex.runtime.changeset_orchestrator as orchestrator

    original_apply_workflow = orchestrator.apply_workflow
    if getattr(original_apply_workflow, "_main_session_progress_feedback", False):
        return

    def apply_workflow_with_progress(*args, **kwargs):
        emit = kwargs.get("emit")
        if not callable(emit):
            return original_apply_workflow(*args, **kwargs)

        repo_root = _repo_root(args, kwargs)
        run_id = str(kwargs.get("run_id") or f"run-{uuid4().hex[:12]}")
        if kwargs.get("run_id") != run_id:
            kwargs = {**kwargs, "run_id": run_id}

        started_at = monotonic()
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="harness-workflow") as executor:
            future = executor.submit(original_apply_workflow, *args, **kwargs)
            while True:
                try:
                    return future.result(timeout=PROGRESS_INTERVAL_SECONDS)
                except TimeoutError:
                    message = _progress_message(repo_root, run_id, monotonic() - started_at)
                    if message is not None:
                        emit(message)

    apply_workflow_with_progress._main_session_progress_feedback = True
    orchestrator.apply_workflow = apply_workflow_with_progress


def _repo_root(args: tuple[object, ...], kwargs: Mapping[str, Any]) -> Path:
    if "repo_root" in kwargs:
        return Path(kwargs["repo_root"])
    if args:
        return Path(args[0])
    raise TypeError("apply_workflow requires repo_root")


def _progress_message(repo_root: Path, run_id: str, elapsed_seconds: float) -> str | None:
    active = _active_step_event(read_run_events(repo_root, run_id))
    if active is None:
        return None

    change_set_id = str(active.get("change_set_id") or "-")
    work_item_id = str(active.get("work_item_id") or "-")
    step_id = str(active.get("step_id") or "-")
    elapsed = max(0, int(elapsed_seconds))
    return (
        f"진행 중: ChangeSet {change_set_id}, Work item {work_item_id}, "
        f"step={step_id} ({elapsed}초 경과)"
    )


def _active_step_event(events: tuple[Mapping[str, Any], ...]) -> Mapping[str, Any] | None:
    active: Mapping[str, Any] | None = None
    for event in events:
        event_type = event.get("event_type")
        if event_type == "step.started":
            active = event
        elif (
            event_type in {"step.finished", "step.raised"}
            and active is not None
            and event.get("step_id") == active.get("step_id")
        ):
            active = None
    return active
