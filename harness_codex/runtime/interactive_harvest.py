"""Terminal interface for the runtime-backed harvest session service."""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

from harness_codex.runtime import BasicStepRunner, RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.harvest_ui import (
    SESSION_PATH,
    USE_CASE_SLICE_ROOT,
    HarvestUiResult,
    answer_use_cases,
    answer_requirements,
    load_harvest_ui,
    start_requirements,
    start_use_case_generation,
    start_use_cases,
)

InputFunc = Callable[[str], str]
OutputFunc = Callable[[str], None]
INTERACTIVE_SESSION_DIR = Path(".harness/ui/sessions")
LANGUAGE_RECOVERY_STAGE = "ubiquitous_language"


def run_interactive_harvest(
    repo_root: Path | str,
    idea: str,
    *,
    session_id: str | None = None,
    resume: bool = False,
    input_func: InputFunc = input,
    output_func: OutputFunc = print,
) -> str:
    """Run or resume Grill-Me harvest, then generate runtime-ready UC slices."""

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
        prompt = _utf8_safe_text(idea).strip()
        if not prompt:
            raise ValueError("--idea is required when using --interactive")
        if _session_file(root, resolved_session_id).exists():
            raise ValueError(
                f"harvest session already exists: {resolved_session_id}. Use --resume with this session id instead."
            )
        _write_initial_named_session(root, resolved_session_id, prompt)
        result = start_requirements(root, prompt)
        _persist_session(root, resolved_session_id)
        output_func(_format_session_header(result, resolved_session_id, resumed=False))

    while True:
        while not result.requirements_gate_passed:
            output_func(_format_questions(result))
            answer = _utf8_safe_text(input_func("Answer: ")).strip()
            if not answer:
                raise ValueError("answer is required")
            _restore_session(root, resolved_session_id)
            if result.active_stage == LANGUAGE_RECOVERY_STAGE:
                result = _answer_language_validation(root, answer)
            else:
                result = answer_requirements(root, answer)
            _persist_session(root, resolved_session_id)

        _restore_session(root, resolved_session_id)
        try:
            _validate_interactive_context(root, resolved_session_id, result.initial_prompt)
        except ValueError as exc:
            output_func(_format_validation_recovery_message(str(exc)))
            result = _open_language_validation_recovery(root, resolved_session_id, str(exc))
            _persist_session(root, resolved_session_id)
            continue
        break

    result = start_use_case_generation(root, result.initial_prompt)
    _persist_session(root, resolved_session_id)
    while not result.use_cases_ready:
        output_func(_format_questions(result))
        answer = _utf8_safe_text(input_func("Answer: ")).strip()
        if not answer:
            raise ValueError("answer is required")
        _restore_session(root, resolved_session_id)
        result = answer_use_cases(root, answer, result.initial_prompt)
        _persist_session(root, resolved_session_id)
    result = start_use_cases(root)
    _persist_session(root, resolved_session_id)
    return _format_completion(root, result, resolved_session_id)


def list_harvest_sessions(repo_root: Path | str) -> str:
    root = Path(repo_root)
    session_dir = root / INTERACTIVE_SESSION_DIR
    if not session_dir.exists():
        return "No harvest sessions found"
    paths = sorted(session_dir.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True)
    if not paths:
        return "No harvest sessions found"
    rows = [_session_row(path) for path in paths]
    headers = ("Session ID", "Stage", "Requirements Gate", "Use Cases", "Initial Idea")
    widths = [max(len(headers[i]), *(len(row[i]) for row in rows)) for i in range(len(headers))]
    lines = ["  ".join(header.ljust(widths[i]) for i, header in enumerate(headers))]
    lines.extend("  ".join(cell.ljust(widths[i]) for i, cell in enumerate(row)) for row in rows)
    return "\n".join(lines)


def _generate_runtime_ready_use_cases(root: Path, session_id: str, idea: str) -> None:
    run_id = f"interactive-harvest-{uuid4().hex[:12]}"
    context = RunContext(
        run_id=run_id,
        workflow_name="harvest-workflow",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=root / ".harness/runs" / run_id,
        metadata={
            "stage": "interactive_harvest",
            "interactive_session_id": session_id,
            "initial_idea": _utf8_safe_text(idea),
            "next_runtime_step": "changes create-from-design",
        },
    )
    runner = BasicStepRunner()
    for step in _interactive_use_case_generation_steps():
        result = runner.run(step, context)
        if result.status != StepStatus.SUCCEEDED:
            raise ValueError(f"interactive harvest step failed: {step.id}: {result.error or result.status.value}")


def _validate_interactive_context(root: Path, session_id: str, idea: str) -> None:
    run_id = f"interactive-harvest-{uuid4().hex[:12]}"
    context = RunContext(
        run_id=run_id,
        workflow_name="harvest-workflow",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=root / ".harness/runs" / run_id,
        metadata={
            "stage": "interactive_harvest",
            "interactive_session_id": session_id,
            "initial_idea": _utf8_safe_text(idea),
            "next_runtime_step": "harvest-use-cases",
        },
    )
    runner = BasicStepRunner()
    result = runner.run(_interactive_use_case_generation_steps()[0], context)
    if result.status != StepStatus.SUCCEEDED:
        raise ValueError(f"interactive harvest step failed: validate-context-language: {result.error or result.status.value}")


def _interactive_use_case_generation_steps() -> tuple[Step, ...]:
    return (
        Step(
            id="validate-context-language",
            kind=StepKind.VALIDATOR,
            name="Validate confirmed ubiquitous language",
            command="python3 -m harness_codex.context_language --repo-root .",
            inputs=(Path("context.md"), Path("docs/design/요구사항.md")),
            timeout_sec=300,
            metadata={
                "stage": "harvest",
                "scope": "ubiquitous_language",
                "interactive": True,
            },
        ),
        Step(
            id="harvest-use-cases",
            kind=StepKind.AGENT,
            name="Derive runtime-ready use case docs",
            agent_id="harness_usecases",
            skill_id="harness-usecases",
            inputs=(Path("context.md"), Path("docs/design/요구사항.md")),
            outputs=(Path("docs/design/유스케이스.md"), Path("docs/use-cases")),
            timeout_sec=3600,
            metadata={
                "stage": "harvest",
                "scope": "runtime_ready_use_cases",
                "interactive": True,
                "slice_outputs": {"root": "docs/use-cases", "required_per_use_case": ("use-case.md", "e2e-goal.md")},
            },
        ),
    )


def _session_row(path: Path) -> tuple[str, str, str, str, str]:
    session_id = path.stem
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return (session_id, "ERROR", "error", "error", f"invalid session file: {exc}")
    stage = str(data.get("active_stage") or "-")
    requirements_gate = "passed" if data.get("requirements_gate_passed") else "running"
    use_cases = "yes" if data.get("use_cases_ready") else "no"
    initial_idea = _utf8_safe_text(data.get("initial_prompt") or "-").replace("\n", " ")
    if len(initial_idea) > 80:
        initial_idea = initial_idea[:77] + "..."
    return (session_id, stage, requirements_gate, use_cases, initial_idea)


def _resolve_session_id(value: str | None) -> str:
    text = _utf8_safe_text(value or "").strip()
    return text or f"harvest-{uuid4().hex[:12]}"


def _session_file(root: Path, session_id: str) -> Path:
    return root / INTERACTIVE_SESSION_DIR / f"{session_id}.json"


def _write_initial_named_session(root: Path, session_id: str, prompt: str) -> None:
    payload = {
        "initial_prompt": _utf8_safe_text(prompt),
        "clarifications": [],
        "current_question": None,
        "current_questions": [],
        "pending_questions": [],
        "language_clarifications": [],
        "requirements_gate_passed": False,
        "active_stage": "requirements",
        "use_cases_ready": False,
        "runtime_error": "question_generating",
    }
    target = _session_file(root, session_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(_json_dumps_utf8_safe(payload) + "\n", encoding="utf-8")


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


def _format_session_header(result: HarvestUiResult, session_id: str, *, resumed: bool) -> str:
    verb = "resumed" if resumed else "started"
    return "\n".join([
        f"INTERACTIVE HARVEST {verb}",
        f"Session ID: {session_id}",
        f"Initial idea: {_utf8_safe_text(result.initial_prompt)}",
        f"Active stage: {result.active_stage}",
    ])


def _format_questions(result: HarvestUiResult) -> str:
    heading = "Ubiquitous Language Grill-Me questions:" if result.active_stage == LANGUAGE_RECOVERY_STAGE else "Grill-Me questions:"
    lines = ["", heading]
    for index, item in enumerate(result.current_questions, start=1):
        lines.append(f"{index}. {_utf8_safe_text(item.get('question', ''))}")
        recommended = _utf8_safe_text(item.get("recommended", ""))
        if recommended:
            lines.append(f"   Recommended answer: {recommended}")
    return "\n".join(lines)


def _open_language_validation_recovery(
    root: Path,
    session_id: str,
    error: str,
) -> HarvestUiResult:
    session_path = root / SESSION_PATH
    session = json.loads(session_path.read_text(encoding="utf-8"))
    questions = _validation_recovery_questions(_utf8_safe_text(error))
    session.setdefault("language_clarifications", [])
    session["requirements_gate_passed"] = False
    session["active_stage"] = LANGUAGE_RECOVERY_STAGE
    session["use_cases_ready"] = False
    session["runtime_error"] = ""
    session["current_question"] = questions[0]
    session["current_questions"] = [questions[0]]
    session["pending_questions"] = questions[1:]
    session["use_case_current_question"] = None
    session["use_case_current_questions"] = []
    session["use_case_pending_questions"] = []
    session_path.write_text(_json_dumps_utf8_safe(session) + "\n", encoding="utf-8")
    return load_harvest_ui(root)


def _answer_language_validation(root: Path, answer: str) -> HarvestUiResult:
    session_path = root / SESSION_PATH
    session = json.loads(session_path.read_text(encoding="utf-8"))
    normalized_answer = _utf8_safe_text(answer).strip()
    if not normalized_answer:
        raise ValueError("answer is required")
    current_question = session.get("current_question")
    if not isinstance(current_question, dict) or not current_question.get("question"):
        raise ValueError("no active Ubiquitous Language question")

    session.setdefault("language_clarifications", []).append(
        {
            "questions": [
                {
                    "question": current_question.get("question", ""),
                    "recommended": current_question.get("recommended", ""),
                }
            ],
            "answer": normalized_answer,
        }
    )
    _apply_language_validation_answer(root, session, current_question, normalized_answer)

    pending = list(session.get("pending_questions") or [])
    if pending:
        next_question = pending.pop(0)
        session["requirements_gate_passed"] = False
        session["active_stage"] = LANGUAGE_RECOVERY_STAGE
        session["current_question"] = next_question
        session["current_questions"] = [next_question]
        session["pending_questions"] = pending
    else:
        session["requirements_gate_passed"] = True
        session["active_stage"] = LANGUAGE_RECOVERY_STAGE
        session["current_question"] = None
        session["current_questions"] = []
        session["pending_questions"] = []
    session["runtime_error"] = ""
    session_path.write_text(_json_dumps_utf8_safe(session) + "\n", encoding="utf-8")
    return load_harvest_ui(root)


def _validation_recovery_questions(error: str) -> list[dict[str, str]]:
    violations = [line[2:].strip() for line in error.splitlines() if line.strip().startswith("- ")]
    questions: list[dict[str, str]] = []
    for violation in violations:
        questions.append(_validation_question_for_violation(violation))
    if questions:
        return questions
    return [
        {
            "question": "The confirmed Ubiquitous Language still fails validation. Which canonical term should be replaced, removed, or allowed before use-case generation continues?",
            "recommended": "Answer only with the terminology decision: replace with a canonical term, remove the offending term, or allow it as canonical in context.md.",
            "language_scope": LANGUAGE_RECOVERY_STAGE,
        }
    ]


def _validation_question_for_violation(violation: str) -> dict[str, str]:
    prefix = " contains forbidden term: "
    if prefix in violation:
        path, term = violation.split(prefix, maxsplit=1)
        clean_path = path.strip()
        clean_term = term.strip()
        return {
            "question": (
                f"Blocked Ubiquitous Language term `{clean_term}` was found in {clean_path}. "
                "Should it be replaced with a canonical term, removed from the document, or allowed as canonical?"
            ),
            "recommended": (
                "Answer only with one terminology decision. Examples: "
                "`replace with <canonical term>`, `remove the line containing this term`, or "
                "`allow this term as canonical in context.md`."
            ),
            "language_scope": LANGUAGE_RECOVERY_STAGE,
            "violation": violation,
            "source_path": clean_path,
            "blocked_term": clean_term,
        }
    return {
        "question": f"Language validation failed for `{violation}`. What canonical naming decision should be confirmed before use-case generation continues?",
        "recommended": "Confirm only the terminology decision and apply it consistently across the requirements draft and context language.",
        "language_scope": LANGUAGE_RECOVERY_STAGE,
        "violation": violation,
    }


def _apply_language_validation_answer(
    root: Path,
    session: dict[str, object],
    question: dict[str, object],
    answer: str,
) -> None:
    term = _utf8_safe_text(question.get("blocked_term", "")).strip()
    if not term:
        _sync_language_drafts_from_disk(root, session)
        return

    target_paths = _language_target_paths(root, question)
    replacement = _extract_replacement_term(answer)
    for path in target_paths:
        if _is_remove_language_answer(answer):
            _remove_term_lines_from_file(path, term)
        elif replacement:
            _replace_term_in_file(path, term, replacement)
    _sync_language_drafts_from_disk(root, session)


def _language_target_paths(root: Path, question: dict[str, object]) -> list[Path]:
    paths: list[Path] = []
    raw_path = _utf8_safe_text(question.get("source_path", "")).strip()
    if raw_path:
        paths.append(root / raw_path)
    context_path = root / "context.md"
    if context_path not in paths:
        paths.append(context_path)
    return paths


def _is_remove_language_answer(answer: str) -> bool:
    lowered = answer.lower()
    return any(marker in lowered for marker in ("remove", "delete", "삭제", "제거", "지워"))


def _extract_replacement_term(answer: str) -> str:
    text = answer.strip()
    parts = text.split("`")
    if len(parts) >= 3 and parts[1].strip():
        return _clean_replacement_term(parts[1])
    lowered = text.lower()
    marker = "replace with "
    if marker in lowered:
        start = lowered.index(marker) + len(marker)
        return _clean_replacement_term(text[start:])
    marker = "use "
    consistently = " consistently"
    if lowered.startswith(marker) and consistently in lowered:
        end = lowered.index(consistently)
        return _clean_replacement_term(text[len(marker):end])
    return ""


def _clean_replacement_term(value: str) -> str:
    return value.strip().strip("`'\" .;:，,。")


def _replace_term_in_file(path: Path, term: str, replacement: str) -> None:
    if not path.exists() or not replacement:
        return
    text = path.read_text(encoding="utf-8")
    if term not in text:
        return
    path.write_text(text.replace(term, replacement), encoding="utf-8")


def _remove_term_lines_from_file(path: Path, term: str) -> None:
    if not path.exists():
        return
    text = path.read_text(encoding="utf-8")
    if term not in text:
        return
    kept_lines = [line for line in text.splitlines() if term not in line]
    path.write_text("\n".join(kept_lines).rstrip() + "\n", encoding="utf-8")


def _sync_language_drafts_from_disk(root: Path, session: dict[str, object]) -> None:
    requirements_path = root / "docs/design/요구사항.md"
    context_path = root / "context.md"
    if requirements_path.exists():
        session["draft_requirements_markdown"] = requirements_path.read_text(encoding="utf-8").strip()
    if context_path.exists():
        session["draft_context_markdown"] = context_path.read_text(encoding="utf-8").strip()


def _format_validation_recovery_message(error: str) -> str:
    return "\n".join(
        [
            "Language validation blocked use-case generation.",
            _utf8_safe_text(error),
            "Opening Ubiquitous Language questions only; requirements Grill-Me remains closed.",
        ]
    )


def _format_completion(root: Path, result: HarvestUiResult, session_id: str) -> str:
    generated = ["- docs/design/요구사항.md", "- context.md", "- docs/design/유스케이스.md"]
    generated.extend(f"- {path}" for path in _generated_use_case_slice_paths(root))
    return "\n".join([
        "INTERACTIVE HARVEST completed",
        f"Session ID: {session_id}",
        "Requirements gate: passed",
        "Generated artifacts:",
        *generated,
        "Next step:",
        './harness changes create-from-design --title "<change title>"',
    ])


def _generated_use_case_slice_paths(root: Path) -> list[Path]:
    slice_root = root / USE_CASE_SLICE_ROOT
    if not slice_root.exists():
        return []
    paths: list[Path] = []
    for directory in sorted(slice_root.glob("UC-*")):
        for name in ("use-case.md", "e2e-goal.md"):
            path = directory / name
            if path.exists():
                paths.append(path.relative_to(root))
    return paths


def _completed_session_message(session_id: str) -> str:
    return "\n".join([
        f"harvest session already completed: {session_id}",
        "Current stage: useCases",
        "Next step:",
        './harness changes create-from-design --title "<change title>"',
    ])


def _utf8_safe_text(value: object) -> str:
    """Return text that can always be encoded as UTF-8.

    Terminal paste buffers can contain lone surrogate code points. Python strings
    can hold them, but UTF-8 file writes reject them with
    `surrogates not allowed`. Replacing them at the interactive boundary keeps
    harvest state, prompts, and generated docs writable.
    """

    return str(value).encode("utf-8", errors="replace").decode("utf-8")


def _json_dumps_utf8_safe(value: object) -> str:
    return _utf8_safe_text(json.dumps(value, ensure_ascii=False, indent=2))
