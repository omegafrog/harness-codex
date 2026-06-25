"""Enable batches of up to three Grill-Me questions per requirements turn."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

MAX_GRILL_ME_QUESTIONS = 3
_PATCHED = "_harness_grill_me_question_batch_patch_applied"


def apply_grill_me_question_batch_patch() -> None:
    """Align Grill-Me prompts, parsing, and terminal answers around a three-question cap."""

    from harness_codex.runtime import harvest_ui, interactive_harvest

    if getattr(harvest_ui, _PATCHED, False):
        return

    harvest_ui._grill_me_prompt = _grill_me_prompt
    harvest_ui._grill_me_finalization_prompt = _grill_me_finalization_prompt
    harvest_ui._parse_grill_me_turn_json = _parse_grill_me_turn_json
    harvest_ui._parse_grill_me_json = _parse_grill_me_json
    interactive_harvest.run_interactive_harvest = _run_interactive_harvest
    setattr(harvest_ui, _PATCHED, True)


def _grill_me_prompt(session: dict[str, Any]) -> str:
    from harness_codex.runtime import harvest_ui

    return f"""Use $grill-me to clarify requirements.

Return only JSON with keys: complete, questions.
When incomplete, return between 1 and {MAX_GRILL_ME_QUESTIONS} question objects in questions[].
Each question object must have keys: question, recommended.

Question rules:
- Ask no more than {MAX_GRILL_ME_QUESTIONS} focused questions in one turn.
- Prioritize the most blocking unresolved decisions first.
- Keep the loop scoped to one MVP and one use-case-sized ChangeSet.
- Do not ask any question already present in Compact Q/A history.
- Do not ask semantically equivalent questions to prior or active questions.
- If a previous answer is partial, ask only for the missing detail.
- Generate questions only from unresolved decisions.
- Do not queue non-blocking follow-up questions.
- Do not ask detailed canonical naming, alias, forbidden-term, aggregate naming, domain event naming, or state-transition naming questions.
- Return complete=true once the confirmed decisions are sufficient to draft docs/design/요구사항.md.

Initial prompt:
{session["initial_prompt"]}

Compact Q/A history:
{json.dumps(harvest_ui._question_turn_history(session), ensure_ascii=False, indent=2)}
"""


def _grill_me_finalization_prompt(
    session: dict[str, Any],
    requirements_skill_path: Path,
    language_skill_path: Path,
) -> str:
    from harness_codex.runtime import harvest_ui

    return f"""Use the confirmed requirement decisions below to draft the final harvest documents.

Return only JSON with keys: complete, questions, requirements_markdown.
Always include draft requirements_markdown that reflects the current confirmed state.
When incomplete, return between 1 and {MAX_GRILL_ME_QUESTIONS} question objects in questions[].
Each question object must have keys: question, recommended.

Question rules:
- Ask no more than {MAX_GRILL_ME_QUESTIONS} focused questions in one turn.
- Prioritize the most blocking unresolved decisions first.
- Do not ask any question already present in Compact Q/A history.
- Do not queue non-blocking follow-up questions.

Document rules:
- In requirements_markdown, never use a clarification table column named `Answer`; use `Response`.
- requirements_markdown must follow harness-requirements and must not write or finalize `context.md`.
- Requirements may include Language Handoff Notes for the ubiquitous-language stage.
- Do not produce `context_markdown`; `context.md` belongs to harness-ubiquitous-language.

Initial prompt:
{session["initial_prompt"]}

Compact Q/A history:
{json.dumps(harvest_ui._question_turn_history(session), ensure_ascii=False, indent=2)}

Harness requirements standards:
- Load `{requirements_skill_path}`.
- Then read `.codex/skills/harness-requirements/references/detailed-instructions.md`.
- Do not load `{language_skill_path}` for requirements finalization.
- Read additional referenced files only if the current draft needs them.
"""


def _parse_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if match is None:
            raise ValueError(f"Grill-Me returned non-JSON output: {stripped}") from None
        data = json.loads(match.group(0))
    if not isinstance(data, dict):
        raise ValueError("Grill-Me returned invalid JSON object")
    return data


def _parse_questions(data: dict[str, Any], *, complete: bool) -> list[dict[str, str]]:
    raw_questions = data.get("questions", [])
    if not isinstance(raw_questions, list):
        raise ValueError("Grill-Me returned invalid questions")

    questions: list[dict[str, str]] = []
    for item in raw_questions[:MAX_GRILL_ME_QUESTIONS]:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question", "")).strip()
        recommended = str(item.get("recommended", "")).strip()
        if question:
            questions.append({"question": question, "recommended": recommended})

    if not complete and not questions:
        legacy_question = str(data.get("question", "")).strip()
        legacy_recommended = str(data.get("recommended", "")).strip()
        if legacy_question:
            questions.append({"question": legacy_question, "recommended": legacy_recommended})
    return questions


def _parse_grill_me_turn_json(text: str) -> dict[str, Any]:
    data = _parse_json_object(text)
    complete = bool(data.get("complete"))
    return {"complete": complete, "questions": _parse_questions(data, complete=complete)}


def _parse_grill_me_json(text: str) -> dict[str, Any]:
    data = _parse_json_object(text)
    complete = bool(data.get("complete"))
    return {
        "complete": complete,
        "questions": _parse_questions(data, complete=complete),
        "requirements_markdown": str(data.get("requirements_markdown", "") or "").strip(),
    }


def _read_active_answers(
    result: Any,
    input_func: Callable[[str], str],
    utf8_safe_text: Callable[[str], str],
) -> str | list[str]:
    questions = tuple(result.current_questions)
    if len(questions) <= 1:
        answer = utf8_safe_text(input_func("Answer: ")).strip()
        if not answer:
            raise ValueError("answer is required")
        return answer

    answers: list[str] = []
    for index in range(len(questions)):
        answer = utf8_safe_text(input_func(f"Answer {index + 1}: ")).strip()
        if not answer:
            raise ValueError("answer is required")
        answers.append(answer)
    return answers


def _run_interactive_harvest(
    repo_root: Path | str,
    idea: str,
    *,
    session_id: str | None = None,
    resume: bool = False,
    input_func: Callable[[str], str] = input,
    output_func: Callable[[str], None] = print,
) -> str:
    from harness_codex.runtime import interactive_harvest as interactive

    root = Path(repo_root)
    resolved_session_id = interactive._resolve_session_id(session_id)

    if resume:
        interactive._restore_session(root, resolved_session_id)
        result = interactive.load_harvest_ui(root)
        interactive._persist_session(root, resolved_session_id)
        if not result.initial_prompt:
            raise ValueError(f"harvest session is empty: {resolved_session_id}")
        if result.use_cases_ready:
            raise ValueError(interactive._completed_session_message(resolved_session_id))
        output_func(interactive._format_session_header(result, resolved_session_id, resumed=True))
    else:
        prompt = interactive._utf8_safe_text(idea).strip()
        if not prompt:
            raise ValueError("--idea is required when using --interactive")
        if interactive._session_file(root, resolved_session_id).exists():
            raise ValueError(
                f"harvest session already exists: {resolved_session_id}. Use --resume with this session id instead."
            )
        interactive._write_initial_named_session(root, resolved_session_id, prompt)
        result = interactive.start_requirements(root, prompt)
        interactive._persist_session(root, resolved_session_id)
        output_func(interactive._format_session_header(result, resolved_session_id, resumed=False))

    while True:
        while not result.requirements_gate_passed:
            output_func(interactive._format_questions(result))
            answer = _read_active_answers(result, input_func, interactive._utf8_safe_text)
            interactive._restore_session(root, resolved_session_id)
            if result.active_stage == interactive.LANGUAGE_RECOVERY_STAGE:
                if isinstance(answer, list):
                    raise ValueError("language recovery accepts one answer at a time")
                result = interactive._answer_language_validation(root, answer)
            else:
                result = interactive.answer_requirements(root, answer)
            interactive._persist_session(root, resolved_session_id)

        interactive._restore_session(root, resolved_session_id)
        try:
            interactive._validate_interactive_context(root, resolved_session_id, result.initial_prompt)
        except ValueError as exc:
            output_func(interactive._format_validation_recovery_message(str(exc)))
            result = interactive._open_language_validation_recovery(root, resolved_session_id, str(exc))
            interactive._persist_session(root, resolved_session_id)
            continue
        language_summary = interactive._format_ubiquitous_language_summary(root)
        if language_summary:
            output_func(language_summary)
        result = interactive.complete_ubiquitous_language(root)
        interactive._persist_session(root, resolved_session_id)
        break

    result = interactive.start_use_case_generation(root, result.initial_prompt)
    interactive._persist_session(root, resolved_session_id)
    while not result.use_cases_ready:
        output_func(interactive._format_questions(result))
        answer = interactive._utf8_safe_text(input_func("Answer: ")).strip()
        if not answer:
            raise ValueError("answer is required")
        interactive._restore_session(root, resolved_session_id)
        result = interactive.answer_use_cases(root, answer, result.initial_prompt)
        interactive._persist_session(root, resolved_session_id)
    result = interactive.start_use_cases(root)
    interactive._persist_session(root, resolved_session_id)
    return interactive._format_completion(root, result, resolved_session_id)
