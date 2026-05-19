"""Local UI session helpers for harvest requirements and use-case generation."""

from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

SESSION_PATH = Path(".harness/ui/harvest-session.json")
REQUIREMENTS_PATH = Path("docs/design/요구사항.md")
USE_CASES_PATH = Path("docs/design/유스케이스.md")
GRILL_ME_SKILL_PATH = Path(".codex/skills/grill-me/SKILL.md")


@dataclass(frozen=True)
class HarvestUiResult:
    initial_prompt: str
    status: str
    active_stage: str
    requirements_markdown: str
    use_cases_markdown: str
    clarifications: tuple[dict[str, Any], ...]
    current_question: dict[str, Any] | None
    current_questions: tuple[dict[str, Any], ...]
    requirements_gate_passed: bool
    use_cases_ready: bool
    runtime_error: str
    workflow: dict[str, Any]


def start_requirements(root: Path | str, prompt: str) -> HarvestUiResult:
    root_path = Path(root)
    session = {
        "initial_prompt": prompt.strip(),
        "clarifications": [],
        "current_question": None,
        "current_questions": [],
        "requirements_gate_passed": False,
        "active_stage": "requirements",
        "use_cases_ready": False,
        "runtime_error": "",
    }
    if not session["initial_prompt"]:
        raise ValueError("initial prompt is required")
    _advance_grill_me(root_path, session)
    _write_requirements_doc(root_path, session)
    _write_session(root_path, session)
    return _result(root_path, session)


def answer_requirements(root: Path | str, answer: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    normalized_answer = answer.strip()
    if not normalized_answer:
        raise ValueError("answer is required")
    questions = session.get("current_questions") or []
    if not questions:
        raise ValueError("no active Grill-Me question")
    session["clarifications"].append(
        {
            "questions": [
                {"question": item.get("question", ""), "recommended": item.get("recommended", "")}
                for item in questions
            ],
            "answer": normalized_answer,
        }
    )
    session["current_questions"] = []
    session["current_question"] = None
    _advance_grill_me(root_path, session)
    _write_requirements_doc(root_path, session)
    _write_session(root_path, session)
    return _result(root_path, session)


def start_use_cases(root: Path | str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    if not session["requirements_gate_passed"]:
        raise ValueError("requirements gate has not passed")
    session["active_stage"] = "useCases"
    session["use_cases_ready"] = True
    _write_use_cases_doc(root_path, session)
    _write_session(root_path, session)
    return _result(root_path, session)


def load_harvest_ui(root: Path | str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_session(root_path)
    if session is None:
        session = _session_from_requirements_doc(root_path)
    if session is None:
        session = {
            "initial_prompt": "",
            "clarifications": [],
            "current_question": None,
            "current_questions": [],
            "requirements_gate_passed": False,
            "active_stage": "requirements",
            "use_cases_ready": False,
            "runtime_error": "",
        }
    else:
        _resume_if_needed(root_path, session)
    return _result(root_path, session)


def _workflow_projection() -> dict[str, Any]:
    return {
        "stages": [
            {"id": "requirements", "label": "Requirements", "document": str(REQUIREMENTS_PATH)},
            {"id": "useCases", "label": "Use Cases", "document": str(USE_CASES_PATH)},
        ]
    }


def _load_or_recover_session(root: Path) -> dict[str, Any]:
    session = _load_session(root)
    if session is None:
        session = _session_from_requirements_doc(root)
    if session is None:
        raise ValueError("harvest session has not started")
    session["clarifications"] = [
        _normalize_clarification(item)
        for item in session.get("clarifications", [])
    ]
    return session


def _load_session(root: Path) -> dict[str, Any] | None:
    path = root / SESSION_PATH
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _resume_if_needed(root: Path, session: dict[str, Any]) -> None:
    if session["requirements_gate_passed"]:
        return
    if session.get("current_questions"):
        return
    try:
        _advance_grill_me(root, session)
    except ValueError as exc:
        session["runtime_error"] = str(exc)
    _write_session(root, session)


def _session_from_requirements_doc(root: Path) -> dict[str, Any] | None:
    path = root / REQUIREMENTS_PATH
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    initial_prompt = _extract_markdown_value(text, "Initial idea")
    if not initial_prompt:
        return None
    clarifications = tuple(_parse_grill_me_rows(text))
    gate_passed = "Current gate: Passed" in text
    session = {
        "initial_prompt": initial_prompt,
        "clarifications": list(clarifications),
        "current_question": None,
        "current_questions": [],
        "requirements_gate_passed": gate_passed,
        "active_stage": "requirements",
        "use_cases_ready": (root / USE_CASES_PATH).exists(),
        "runtime_error": "",
    }
    if session["use_cases_ready"]:
        session["active_stage"] = "useCases"
    return session


def _extract_markdown_value(text: str, label: str) -> str:
    match = re.search(rf"^- {re.escape(label)}:\s*(.+)$", text, flags=re.MULTILINE)
    return match.group(1).strip() if match else ""


def _parse_grill_me_rows(text: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in text.splitlines():
        if not line.startswith("| GM-"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 3:
            continue
        question_text = cells[1]
        answer = cells[2]
        questions = [
            {"question": item, "recommended": ""}
            for item in _split_recovered_questions(question_text)
        ]
        rows.append({"questions": questions, "answer": answer})
    return rows


def _split_recovered_questions(text: str) -> list[str]:
    parts = [part.strip() for part in text.split("<br>") if part.strip()]
    if not parts:
        return [text.strip()] if text.strip() else []
    return [re.sub(r"^\d+\.\s*", "", part).strip() for part in parts]


def _normalize_clarification(item: dict[str, Any]) -> dict[str, Any]:
    if "questions" in item and isinstance(item["questions"], list):
        return item
    question = str(item.get("question", "")).strip()
    recommended = str(item.get("recommended", "")).strip()
    return {
        "questions": [{"question": question, "recommended": recommended}]
        if question
        else [],
        "answer": str(item.get("answer", "")),
    }


def _write_session(root: Path, session: dict[str, Any]) -> None:
    path = root / SESSION_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(session, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _result(root: Path, session: dict[str, Any]) -> HarvestUiResult:
    session_started = bool(session["initial_prompt"])
    requirements_markdown = (
        _read_optional(root / REQUIREMENTS_PATH) if session_started else ""
    )
    use_cases_markdown = (
        _read_optional(root / USE_CASES_PATH)
        if session_started and session.get("use_cases_ready")
        else ""
    )
    gate_passed = bool(session["requirements_gate_passed"])
    status = "idle" if not session_started else (
        "use_cases_ready" if session.get("use_cases_ready") else (
            "requirements_passed" if gate_passed else "requirements_running"
        )
    )
    current_questions = (
        ()
        if gate_passed or not session_started
        else tuple(session.get("current_questions") or [])
    )
    current_question = current_questions[0] if current_questions else None
    return HarvestUiResult(
        initial_prompt=session["initial_prompt"],
        status=status,
        active_stage=session["active_stage"],
        requirements_markdown=requirements_markdown,
        use_cases_markdown=use_cases_markdown,
        clarifications=tuple(session["clarifications"]),
        current_question=current_question,
        current_questions=current_questions,
        requirements_gate_passed=gate_passed,
        use_cases_ready=bool(session.get("use_cases_ready")),
        runtime_error=str(session.get("runtime_error", "")),
        workflow=_workflow_projection(),
    )


def _advance_grill_me(root: Path, session: dict[str, Any]) -> None:
    result = _run_grill_me(root, session)
    if result["complete"]:
        session["requirements_gate_passed"] = True
        session["current_question"] = None
        session["current_questions"] = []
    else:
        session["requirements_gate_passed"] = False
        session["current_questions"] = result["questions"]
        session["current_question"] = result["questions"][0]
    session["runtime_error"] = ""


def _run_grill_me(root: Path, session: dict[str, Any]) -> dict[str, Any]:
    skill_path = root / GRILL_ME_SKILL_PATH
    if not skill_path.exists():
        raise ValueError(f"missing required Grill-Me skill: {GRILL_ME_SKILL_PATH}")

    run_dir = root / ".harness/ui/grill-me-runs" / uuid4().hex[:12]
    run_dir.mkdir(parents=True, exist_ok=True)
    final_message_path = run_dir / "final-message.md"
    prompt_path = run_dir / "prompt.md"
    prompt = _grill_me_prompt(root, session, skill_path)
    prompt_path.write_text(prompt, encoding="utf-8")
    command = [
        "codex",
        "exec",
        "--cd",
        str(root),
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
        "--sandbox",
        "workspace-write",
        "--output-last-message",
        str(final_message_path),
        "-",
    ]
    completed = subprocess.run(
        command,
        cwd=root,
        input=prompt,
        text=True,
        capture_output=True,
        timeout=300,
        check=False,
    )
    (run_dir / "stdout.txt").write_text(completed.stdout, encoding="utf-8")
    (run_dir / "stderr.txt").write_text(completed.stderr, encoding="utf-8")
    if completed.returncode != 0:
        error = completed.stderr.strip() or completed.stdout.strip()
        raise ValueError(f"Grill-Me execution failed: {error}")

    final_message = final_message_path.read_text(encoding="utf-8")
    return _parse_grill_me_json(final_message)


def _grill_me_prompt(root: Path, session: dict[str, Any], skill_path: Path) -> str:
    requirements_skill = (root / ".codex/skills/harness-requirements/SKILL.md").read_text(
        encoding="utf-8"
    )
    grill_me_skill = skill_path.read_text(encoding="utf-8")
    return f"""Use $grill-me to clarify requirements.

Return only JSON with keys: complete, questions.
When incomplete, return up to exactly 3 questions in questions[].
Each question object must have keys: question, recommended.

Initial prompt:
{session["initial_prompt"]}

Clarification history:
{json.dumps(session["clarifications"], ensure_ascii=False, indent=2)}

Harness requirements standards:
{requirements_skill}

Grill-Me skill:
{grill_me_skill}
"""


def _parse_grill_me_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if match is None:
            raise ValueError(f"Grill-Me returned non-JSON output: {stripped}")
        data = json.loads(match.group(0))
    complete = bool(data.get("complete"))
    raw_questions = data.get("questions", [])
    if not isinstance(raw_questions, list):
        raise ValueError("Grill-Me returned invalid questions")
    questions = []
    for item in raw_questions[:3]:
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
    return {"complete": complete, "questions": questions}


def _write_requirements_doc(root: Path, session: dict[str, Any]) -> None:
    path = root / REQUIREMENTS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    gate = "Passed" if session["requirements_gate_passed"] else "Needs Clarification"
    lines = [
        "# 요구사항",
        "",
        f"- Initial idea: {session['initial_prompt']}",
        f"- Current gate: {gate}",
        "",
        "## Grill-Me Clarifications",
        "",
        "| ID | Questions | Answer |",
        "| --- | --- | --- |",
    ]
    for index, item in enumerate(session["clarifications"], start=1):
        questions = item.get("questions") or []
        question_text = "<br>".join(
            f"{idx}. {question.get('question', '')}"
            for idx, question in enumerate(questions, start=1)
        )
        lines.append(f"| GM-{index:03d} | {question_text} | {item.get('answer', '')} |")
    if session.get("current_questions"):
        lines.extend(["", "## Open Language Questions", ""])
        for index, item in enumerate(session["current_questions"], start=1):
            recommended = item.get("recommended", "")
            suffix = f" Recommended: {recommended}" if recommended else ""
            lines.append(f"- Q{index}: {item.get('question', '')}{suffix}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_use_cases_doc(root: Path, session: dict[str, Any]) -> None:
    path = root / USE_CASES_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        "# 유스케이스",
        "",
        f"- Source idea: {session['initial_prompt']}",
        "- Status: Draft generated after requirements gate",
        "",
        "## Candidate Use Cases",
        "",
        "- UC-001: TBD from confirmed requirements",
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _read_optional(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""
