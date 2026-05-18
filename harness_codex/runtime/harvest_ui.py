"""Runtime-backed harvest UI session service."""

from __future__ import annotations

import json
import re
import subprocess
from uuid import uuid4
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from harness_codex.runtime.models import HARNESS_FULL_WORKFLOW

REQUIREMENTS_PATH = Path("docs/design/요구사항.md")
USE_CASES_PATH = Path("docs/design/유스케이스.md")
SESSION_PATH = Path(".harness/ui/harvest-session.json")
GRILL_ME_SKILL_PATH = Path(".codex/skills/grill-me/SKILL.md")


@dataclass(frozen=True)
class HarvestUiResult:
    """UI projection for one harvest session."""

    initial_prompt: str
    status: str
    active_stage: str
    requirements_markdown: str
    use_cases_markdown: str
    clarifications: tuple[dict[str, str], ...]
    current_question: dict[str, str] | None
    current_questions: tuple[dict[str, str], ...]
    requirements_gate_passed: bool
    use_cases_ready: bool
    runtime_error: str
    workflow: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return {
            "initial_prompt": self.initial_prompt,
            "status": self.status,
            "active_stage": self.active_stage,
            "requirements_markdown": self.requirements_markdown,
            "use_cases_markdown": self.use_cases_markdown,
            "clarifications": list(self.clarifications),
            "current_question": self.current_question,
            "current_questions": list(self.current_questions),
            "requirements_gate_passed": self.requirements_gate_passed,
            "use_cases_ready": self.use_cases_ready,
            "runtime_error": self.runtime_error,
            "workflow": self.workflow,
        }


def load_harvest_ui(repo_root: Path | str) -> HarvestUiResult:
    root = Path(repo_root)
    session = _load_session(root)
    _ensure_recovered_question(root, session)
    return _result(root, session)


def start_requirements(repo_root: Path | str, prompt: str) -> HarvestUiResult:
    text = prompt.strip()
    if not text:
        raise ValueError("initial prompt is required")

    root = Path(repo_root)
    session = {
        "initial_prompt": text,
        "clarifications": [],
        "current_question": None,
        "current_questions": [],
        "requirements_gate_passed": False,
        "active_stage": "requirements",
        "use_cases_ready": False,
        "runtime_error": "",
    }
    _advance_grill_me(root, session)
    _write_session(root, session)
    _write_requirements(root, session)
    return _result(root, session)


def answer_requirements(repo_root: Path | str, answer: str) -> HarvestUiResult:
    text = answer.strip()
    if not text:
        raise ValueError("answer is required")

    root = Path(repo_root)
    session = _load_session(root)
    if not session["initial_prompt"]:
        raise ValueError("requirements session is not started")
    if session["requirements_gate_passed"]:
        raise ValueError("requirements gate already passed")

    questions = session.get("current_questions") or []
    if not questions:
        raise ValueError("no active Grill-Me question")
    session["clarifications"].append(
        {
            "questions": questions,
            "answer": text,
        }
    )
    session["active_stage"] = "requirements"
    _advance_grill_me(root, session)
    _write_session(root, session)
    _write_requirements(root, session)
    return _result(root, session)


def start_use_cases(repo_root: Path | str) -> HarvestUiResult:
    root = Path(repo_root)
    session = _load_session(root)
    if not session["requirements_gate_passed"]:
        raise ValueError("requirements gate must pass before use cases")

    session["active_stage"] = "useCases"
    session["use_cases_ready"] = True
    _write_session(root, session)
    _write_use_cases(root, session)
    return _result(root, session)


def _load_session(root: Path) -> dict[str, Any]:
    path = root / SESSION_PATH
    if not path.exists():
        recovered = _session_from_requirements_doc(root)
        if recovered is not None:
            _write_session(root, recovered)
            return recovered
        return {
            "initial_prompt": "",
            "clarifications": [],
            "current_question": None,
            "current_questions": [],
            "requirements_gate_passed": False,
            "active_stage": "requirements",
            "use_cases_ready": False,
            "runtime_error": "",
        }
    data = json.loads(path.read_text(encoding="utf-8"))
    data.setdefault("initial_prompt", "")
    data.setdefault("clarifications", [])
    data["clarifications"] = [
        _normalize_clarification(item) for item in data["clarifications"]
    ]
    data.setdefault("current_question", None)
    data.setdefault("current_questions", [])
    data.setdefault("requirements_gate_passed", False)
    data.setdefault("active_stage", "requirements")
    data.setdefault("use_cases_ready", False)
    data.setdefault("runtime_error", "")
    return data


def _ensure_recovered_question(root: Path, session: dict[str, Any]) -> None:
    if not session["initial_prompt"]:
        return
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
            questions.append(
                {"question": legacy_question, "recommended": legacy_recommended}
            )
    if not complete and not questions:
        raise ValueError("Grill-Me returned no questions")
    return {
        "complete": complete,
        "questions": questions,
    }


def _workflow_projection() -> dict[str, Any]:
    return {
        "name": HARNESS_FULL_WORKFLOW.name,
        "steps": [
            {
                "id": step.id,
                "agent_id": step.agent_id,
                "skill_id": step.skill_id,
                "needs": list(step.needs),
                "outputs": [str(path) for path in step.outputs],
            }
            for step in HARNESS_FULL_WORKFLOW.steps
            if step.id in {"harvest-requirements", "harvest-use-cases"}
        ],
    }


def _write_requirements(root: Path, session: dict[str, Any]) -> None:
    path = root / REQUIREMENTS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_requirements_markdown(session), encoding="utf-8")


def _write_use_cases(root: Path, session: dict[str, Any]) -> None:
    path = root / USE_CASES_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_use_cases_markdown(session), encoding="utf-8")


def _requirements_markdown(session: dict[str, Any]) -> str:
    prompt = session["initial_prompt"]
    clarifications = session["clarifications"]
    gate = "Passed" if session["requirements_gate_passed"] else "In progress"
    rows = (
        "| None | Grill-Me has not accepted clarification input yet. | - |"
        if not clarifications
        else "\n".join(
            f"| GM-{index + 1} | {_question_text(item)} | {item['answer']} |"
            for index, item in enumerate(clarifications)
        )
    )
    business = (
        "- None blocking for use-case writing."
        if session["requirements_gate_passed"]
        else "- Grill-Me loop still has unresolved requirement decisions."
    )
    technology = (
        "- Carry unconfirmed technical details into later technical-decision stage when not required for actor goals."
        if session["requirements_gate_passed"]
        else "- Grill-Me loop still checking foundational choices."
    )
    return f"""# Requirements Specification

## 1. Overview
- Initial idea: {prompt}
- Goal: Produce requirements only after Grill-Me clarifies blocking decisions.
- Current gate: {gate}
- Runtime workflow: {HARNESS_FULL_WORKFLOW.name}
- Runtime step: harvest-requirements

## 2. Actors and Stakeholders
- Main actors: Needs confirmation through Grill-Me.
- Supporting actors: Requirements agent, Grill-Me interviewer.
- Stakeholders: Product owner, engineering reviewer.

## 3. Functional Requirements
### 3.1 Requirements Harvest
- FR-001. The runtime shall accept an initial prompt and run the requirements stage first.
- FR-002. The requirements stage shall invoke Grill-Me while requirements are incomplete.
- FR-003. The UI shall submit Grill-Me answers back to the requirements stage.
- FR-004. The runtime shall not run use-case generation until the requirements gate passes.

## 4. Non-Functional Requirements
### 4.1 Traceability
- NFR-001. Each Grill-Me answer shall stay attached to the requirements run.

### 4.2 Operability
- NFR-002. The current requirements result, gate status, and next question shall be visible together.

## 5. Grill-Me Loop
| ID | Question | Answer |
|---|---|---|
{rows}

## 6. Business Policy Decisions Needed
{business}

## 7. Foundational Technology Decisions Needed
{technology}
"""


def _use_cases_markdown(session: dict[str, Any]) -> str:
    prompt = session["initial_prompt"]
    clarifications = session["clarifications"]
    clarification_summary = " / ".join(item["answer"] for item in clarifications)
    return f"""# Use Case Document

## 0. Source Requirements
- Generated only after the requirements gate passed.
- Source artifact: `{REQUIREMENTS_PATH}`
- Runtime workflow: {HARNESS_FULL_WORKFLOW.name}
- Runtime step: harvest-use-cases
- Initial requirement prompt: {prompt}
- Clarification summary: {clarification_summary}

## 1. Actor Definitions
### Main Actors
- Requirements reviewer

### Supporting Actors
- Use-case derivation agent

## 2. High-Level Use Case List
### Harvest Review
- UC-01. User reviews approved requirements.
- UC-02. User generates use cases from approved requirements.
- UC-03. User reviews generated use cases.

## 3. Use Case Details
## UC-01. User reviews approved requirements
**Actor**
- User

**Supporting Actor**
- Requirements agent

**Goal**
- Confirm that requirements are ready for use-case generation.

**Preconditions**
- Requirements gate has passed.

**Main Flow**
1. User opens the requirements result.
2. System shows the approved requirements artifact.
3. User proceeds to use-case generation.

**Exception Flow**
- If the requirements gate has not passed, use-case generation remains unavailable.

**Result**
- Approved requirements become the source input for use-case generation.

**Non-Functional Requirements**
- Requirements source decisions remain traceable.

---

## UC-02. User generates use cases from approved requirements
**Actor**
- User

**Supporting Actor**
- Use-case derivation agent

**Goal**
- Create use cases from the passed requirements result.

**Preconditions**
- Requirements gate has passed.

**Main Flow**
1. User selects Proceed to use cases.
2. Runtime reads the approved requirements output.
3. Runtime runs the harvest-use-cases step.
4. System renders generated use cases.

**Exception Flow**
- If approved requirements are missing, use-case generation does not run.

**Result**
- Use cases are generated from requirements.

**Non-Functional Requirements**
- Generated use cases must cite requirement inputs.
"""


def _question_text(item: dict[str, Any]) -> str:
    if "question" in item:
        return str(item["question"])
    questions = item.get("questions", [])
    if not isinstance(questions, list):
        return ""
    return "<br>".join(
        f"{index + 1}. {question.get('question', '')}"
        for index, question in enumerate(questions)
        if isinstance(question, dict)
    )


def _read_optional(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")
