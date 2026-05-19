"""Terminal interface for the runtime-backed harvest session service."""

from __future__ import annotations

import shutil
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

from harness_codex.runtime.harvest_ui import (
    SESSION_PATH,
    HarvestUiResult,
    answer_requirements,
    load_harvest_ui,
    start_requirements,
    start_use_cases,
)

InputFunc = Callable[[str], str]
OutputFunc = Callable[[str], None]

INTERACTIVE_SESSION_DIR = Path(".harness/ui/sessions")


def run_interactive_harvest(
    repo_root: Path | str,
    idea: str,
    *,
    session_id: str | None = None,
    resume: bool = False,
    input_func: InputFunc = input,
    output_func: OutputFunc = print,
) -> str:
    """Run or resume the Grill-Me-backed harvest loop in a terminal.

    The harvest UI service still owns the question/answer state. This wrapper
    adds a stable session id so a Ctrl-C interrupted interactive run can be
    resumed from the saved local session file.
    """

    root = Path(repo_root)
    resolved_session_id = _resolve_session_id(session_id)

    if resume:
        _restore_session(root, resolved_session_id)
        result = load_harvest_ui(root)
        _persist_session(root, resolved_session_id)
        if not result.initial_prompt:
            raise ValueError(f"harvest session is empty: {resolved_session_id}")
        if result.use_cases_ready:
            raise ValueError(_completed_session_message(resolved_session_id))
        output_func(_format_session_header(result, resolved_session_id, resumed=True))
    else:
        prompt = idea.strip()
        if not prompt:
            raise ValueError("--idea is required when using --interactive")
        if _session_file(root, resolved_session_id).exists():
            raise ValueError(
                f"harvest session already exists: {resolved_session_id}. "
                "Use --resume with this session id instead."
            )
        result = start_requirements(root, prompt)
        _persist_session(root, resolved_session_id)
        output_func(_format_session_header(result, resolved_session_id, resumed=False))

    while not result.requirements_gate_passed:
        output_func(_format_questions(result))
        answer = input_func("Answer: ").strip()
        if not answer:
            raise ValueError("answer is required")
        _restore_session(root, resolved_session_id)
        result = answer_requirements(root, answer)
        _persist_session(root, resolved_session_id)

    _restore_session(root, resolved_session_id)
    result = start_use_cases(root)
    _persist_session(root, resolved_session_id)
    return _format_completion(result, resolved_session_id)


def _resolve_session_id(value: str | None) -> str:
    text = (value or "").strip()
    return text or f"harvest-{uuid4().hex[:12]}"


def _session_file(root: Path, session_id: str) -> Path:
    return root / INTERACTIVE_SESSION_DIR / f"{session_id}.json"


def _restore_session(root: Path, session_id: str) -> None:
    source = _session_file(root, session_id)
    if not source.exists():
        raise ValueError(f"harvest session not found: {session_id}")
    target = root / SESSION_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def _persist_session(root: Path, session_id: str) -> None:
    source = root / SESSION_PATH
    if not source.exists():
        raise ValueError("harvest session state was not written")
    target = _session_file(root, session_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def _format_session_header(
    result: HarvestUiResult,
    session_id: str,
    *,
    resumed: bool,
) -> str:
    verb = "resumed" if resumed else "started"
    return "\n".join(
        [
            f"INTERACTIVE HARVEST {verb}",
            f"Session ID: {session_id}",
            f"Initial idea: {result.initial_prompt}",
            f"Active stage: {result.active_stage}",
        ]
    )


def _format_questions(result: HarvestUiResult) -> str:
    lines = ["", "Grill-Me questions:"]
    for index, item in enumerate(result.current_questions, start=1):
        lines.append(f"{index}. {item.get('question', '')}")
        recommended = item.get("recommended", "")
        if recommended:
            lines.append(f"   Recommended answer: {recommended}")
    return "\n".join(lines)


def _format_completion(result: HarvestUiResult, session_id: str) -> str:
    return "\n".join(
        [
            "INTERACTIVE HARVEST completed",
            f"Session ID: {session_id}",
            "Requirements gate: passed",
            "Generated artifacts:",
            "- docs/design/요구사항.md",
            "- docs/design/유스케이스.md",
            "Next step:",
            './harness changes create-from-design --title "<change title>"',
        ]
    )


def _completed_session_message(session_id: str) -> str:
    return "\n".join(
        [
            f"harvest session already completed: {session_id}",
            "Current stage: useCases",
            "Next step:",
            './harness changes create-from-design --title "<change title>"',
        ]
    )
