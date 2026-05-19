"""Terminal interface for the runtime-backed harvest session service."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from harness_codex.runtime.harvest_ui import (
    HarvestUiResult,
    answer_requirements,
    start_requirements,
    start_use_cases,
)

InputFunc = Callable[[str], str]
OutputFunc = Callable[[str], None]


def run_interactive_harvest(
    repo_root: Path | str,
    idea: str,
    *,
    input_func: InputFunc = input,
    output_func: OutputFunc = print,
) -> str:
    """Run the Grill-Me-backed harvest loop in a terminal.

    The local harvest UI already owns the question/answer session state and the
    requirements gate. This wrapper exposes the same lifecycle for CLI users:
    start requirements, answer current questions until the gate passes, then
    generate use cases.
    """

    prompt = idea.strip()
    if not prompt:
        raise ValueError("--idea is required when using --interactive")

    result = start_requirements(repo_root, prompt)
    output_func(_format_session_header(result))

    while not result.requirements_gate_passed:
        output_func(_format_questions(result))
        answer = input_func("Answer: ").strip()
        if not answer:
            raise ValueError("answer is required")
        result = answer_requirements(repo_root, answer)

    result = start_use_cases(repo_root)
    return _format_completion(result)


def _format_session_header(result: HarvestUiResult) -> str:
    return "\n".join(
        [
            "INTERACTIVE HARVEST started",
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


def _format_completion(result: HarvestUiResult) -> str:
    return "\n".join(
        [
            "INTERACTIVE HARVEST completed",
            "Requirements gate: passed",
            "Generated artifacts:",
            "- docs/design/요구사항.md",
            "- docs/design/유스케이스.md",
            "Next step:",
            './harness changes create-from-design --title "<change title>"',
        ]
    )
