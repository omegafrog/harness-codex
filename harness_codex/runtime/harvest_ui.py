"""Local UI session helpers for harvest requirements and use-case generation."""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
from uuid import uuid4

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.runner import (
    AgentRunRequest,
    ConfigurableCliAgentAdapter,
    _load_agent_config,
)

SESSION_PATH = Path(".harness/ui/harvest-session.json")
CHANGESET_SESSION_ROOT = Path(".harness/ui/change-sets")
REQUIREMENTS_PATH = Path("docs/design/요구사항.md")
CONTEXT_PATH = Path("context.md")
UBIQUITOUS_LANGUAGE_PATH = Path("docs/design/ubiquitous-language.md")
USE_CASES_PATH = Path("docs/design/유스케이스.md")
USE_CASE_SLICE_ROOT = Path("docs/use-cases")
GRILL_ME_SKILL_PATH = Path(".codex/skills/grill-me/SKILL.md")
REQUIREMENTS_SKILL_PATH = Path(".codex/skills/harness-requirements/SKILL.md")
LANGUAGE_SKILL_PATH = Path(".codex/skills/harness-ubiquitous-language/SKILL.md")
REQUIREMENTS_AGENT_CONFIG_PATH = Path(".codex/agents/requirements_interviewer.toml")
USE_CASE_AGENT_CONFIG_PATH = Path(".codex/agents/harness_usecases.toml")
USE_CASE_SKILL_PATH = Path(".codex/skills/harness-usecases/SKILL.md")
USE_CASE_DEFINITION_TIMEOUT_SEC = 3600
EVENT_STORMING_AGENT_CONFIG_PATH = Path(".codex/agents/oracle.toml")
EVENT_STORMING_SKILL_PATH = Path(".codex/skills/harness-event-storming/SKILL.md")
EVENT_STORMING_TIMEOUT_SEC = 3600
ARTIFACT_REVIEWER_AGENT_CONFIG_PATH = Path(".codex/agents/artifact_reviewer.toml")
ARTIFACT_REVIEWER_SKILL_PATH = Path(".codex/skills/harness-artifact-reviewer/SKILL.md")
EVENT_STORMING_REVIEW_ATTEMPTS = 3
DDD_AGENT_CONFIG_PATH = Path(".codex/agents/ddd_architect.toml")
DDD_SKILL_PATH = Path(".codex/skills/harness-ddd-design/SKILL.md")
DDD_TIMEOUT_SEC = 3600
DDD_RUN_ALL_TIMEOUT_SEC = 7200
DDD_STEPS = (
    ("entity_vo", "Entity / Value Objects"),
    ("behaviors", "Behaviors"),
    ("application_flow", "Application Flow"),
    ("aggregates", "Aggregates"),
    ("bounded_contexts", "Bounded Contexts"),
)


@dataclass(frozen=True)
class HarvestUiResult:
    initial_prompt: str
    status: str
    active_stage: str
    requirements_markdown: str
    context_markdown: str
    use_cases_markdown: str
    clarifications: tuple[dict[str, Any], ...]
    current_question: dict[str, Any] | None
    current_questions: tuple[dict[str, Any], ...]
    requirements_gate_passed: bool
    language_gate_passed: bool
    use_cases_ready: bool
    event_storming: dict[str, Any]
    ddd_architecture: dict[str, Any]
    runtime_error: str
    workflow: dict[str, Any]

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


def start_requirements(root: Path | str, prompt: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _new_session(prompt)
    if not session["initial_prompt"]:
        raise ValueError("initial prompt is required")
    _write_session(root_path, session)
    _advance_grill_me(root_path, session)
    _write_requirements_doc(root_path, session)
    _write_session(root_path, session)
    return _result(root_path, session)


def answer_requirements(root: Path | str, answer: str | list[str]) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    current_questions = _current_questions(session)
    if not current_questions:
        raise ValueError("no active Grill-Me question")
    raw_answers = answer if isinstance(answer, list) else [answer]
    normalized_answers = [str(item).strip() for item in raw_answers]
    if len(normalized_answers) != len(current_questions):
        raise ValueError("one answer is required for each active Grill-Me question")
    if any(not item for item in normalized_answers):
        raise ValueError("answer is required")
    session["clarifications"].extend(
        {
            "questions": [
                {
                    "question": question.get("question", ""),
                    "recommended": question.get("recommended", ""),
                }
            ],
            "answer": normalized_answer,
        }
        for question, normalized_answer in zip(current_questions, normalized_answers, strict=True)
    )
    session["current_questions"] = []
    session["current_question"] = None
    session["pending_questions"] = []
    _advance_grill_me(root_path, session)
    _write_requirements_doc(root_path, session)
    _write_session(root_path, session)
    return _result(root_path, session)


def start_ubiquitous_language(root: Path | str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    if not session["requirements_gate_passed"]:
        raise ValueError("requirements gate has not passed")
    _write_context_doc(root_path, session)
    context = _read_language_artifact(root_path).strip()
    if not context:
        raise ValueError("docs/design/ubiquitous-language.md is missing or empty")
    session["active_stage"] = "ubiquitousLanguage"
    session["runtime_error"] = ""
    _write_session(root_path, session)
    return _result(root_path, session)


def complete_ubiquitous_language(root: Path | str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    if not session["requirements_gate_passed"]:
        raise ValueError("requirements gate has not passed")
    _write_context_doc(root_path, session)
    context = _read_language_artifact(root_path).strip()
    if not context:
        raise ValueError("docs/design/ubiquitous-language.md is missing or empty")
    open_questions = _extract_open_language_questions(context)
    if open_questions:
        raise ValueError("ubiquitous language has unresolved open questions")
    session["active_stage"] = "ubiquitousLanguage"
    session["language_gate_passed"] = True
    session["runtime_error"] = ""
    _write_session(root_path, session)
    return _result(root_path, session)


def start_use_cases(root: Path | str) -> HarvestUiResult:
    """Mark use-case harvest complete only after runtime-ready slice docs exist.

    Interactive harvest used to write a local placeholder document here. That made
    the UI look complete while the repository was not ready for ChangeSet
    execution. Use-case docs are now generated by the same agent-backed path as
    apply harvest; this function only validates and records readiness.
    """

    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    if not session["requirements_gate_passed"]:
        raise ValueError("requirements gate has not passed")
    if not session["language_gate_passed"]:
        raise ValueError("ubiquitous-language gate has not passed")
    ready, error = _validate_runtime_ready_use_case_slices(root_path)
    if not ready:
        raise ValueError(error)
    session["active_stage"] = "useCases"
    session["use_cases_ready"] = True
    session["runtime_error"] = ""
    _write_session(root_path, session)
    return _result(root_path, session)


def start_use_case_generation(root: Path | str, idea: str = "") -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    if not session["requirements_gate_passed"]:
        raise ValueError("requirements gate has not passed")
    if not session["language_gate_passed"]:
        raise ValueError("ubiquitous-language gate has not passed")
    session["active_stage"] = "useCases"
    ready, _ = _validate_runtime_ready_use_case_slices(root_path)
    if ready:
        session["use_cases_ready"] = True
        session["runtime_error"] = ""
        _write_session(root_path, session)
        return _result(root_path, session)
    if _current_use_case_question(session) is None:
        _advance_use_case_harvest(root_path, session, idea)
    _write_session(root_path, session)
    return _result(root_path, session)


def answer_use_cases(root: Path | str, answer: str, idea: str = "") -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    if not session["requirements_gate_passed"]:
        raise ValueError("requirements gate has not passed")
    if not session["language_gate_passed"]:
        raise ValueError("ubiquitous-language gate has not passed")
    normalized_answer = answer.strip()
    if not normalized_answer:
        raise ValueError("answer is required")
    current_question = _current_use_case_question(session)
    if current_question is None:
        raise ValueError("no active use-case question")
    session["use_case_clarifications"].append(
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
    session["use_case_current_question"] = None
    session["use_case_current_questions"] = []
    session["use_case_pending_questions"] = []
    _advance_use_case_harvest(root_path, session, idea)
    _write_session(root_path, session)
    return _result(root_path, session)


def start_event_storming(root: Path | str, change_set_id: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    if not session.get("use_cases_ready"):
        raise ValueError("use-case gate has not passed")
    uc_ids = _parse_canonical_use_case_ids(_read_optional(root_path / USE_CASES_PATH))
    if not uc_ids:
        raise ValueError("no generated use-case slices are available for event storming")
    state = session.get("event_storming")
    if not isinstance(state, dict) or state.get("uc_ids") != uc_ids:
        state = _new_event_storming_state(uc_ids)
        session["event_storming"] = state
    session["active_stage"] = "eventStorming"
    if not state.get("complete") and not _current_event_storming_question(session):
        _advance_event_storming(root_path, session, change_set_id)
    _write_session(root_path, session)
    return _result(root_path, session)


def advance_event_storming(root: Path | str, change_set_id: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    if not session.get("use_cases_ready"):
        raise ValueError("use-case gate has not passed")
    state = session.get("event_storming")
    if not isinstance(state, dict):
        raise ValueError("event storming has not started")
    if _current_event_storming_question(session):
        raise ValueError("answer the current event-storming question before continuing")
    _advance_event_storming(root_path, session, change_set_id)
    _write_session(root_path, session)
    return _result(root_path, session)


def answer_event_storming(
    root: Path | str,
    change_set_id: str,
    uc_id: str,
    answer: str,
) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    state = session.get("event_storming")
    if not isinstance(state, dict) or state.get("current_uc") != uc_id:
        raise ValueError("no active event-storming question for use case")
    item = state.get("items", {}).get(uc_id, {})
    question = item.get("current_question")
    normalized_answer = answer.strip()
    if not isinstance(question, dict) or not normalized_answer:
        raise ValueError("answer is required for the current event-storming question")
    item.setdefault("clarifications", []).append(
        {
            "questions": [
                {
                    "question": str(question.get("question", "")),
                    "recommended": str(question.get("recommended", "")),
                }
            ],
            "answer": normalized_answer,
        }
    )
    item["current_question"] = None
    _advance_event_storming(root_path, session, change_set_id, uc_id=uc_id)
    _write_session(root_path, session)
    return _result(root_path, session)


def start_ddd_architecture(root: Path | str, change_set_id: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    event_state = session.get("event_storming")
    if not isinstance(event_state, dict) or not event_state.get("complete"):
        raise ValueError("event-storming gate has not passed")
    uc_ids = [
        uc_id for uc_id in event_state.get("uc_ids", [])
        if event_state.get("items", {}).get(uc_id, {}).get("status") == "complete"
    ]
    if not uc_ids:
        raise ValueError("no completed event-storming slices are available for DDD architecture")
    state = session.get("ddd_architecture")
    if not isinstance(state, dict) or state.get("uc_ids") != uc_ids:
        state = _new_ddd_architecture_state(uc_ids)
        session["ddd_architecture"] = state
    session["active_stage"] = "dddArchitecture"
    if not state.get("complete") and not _current_ddd_question(session):
        _advance_ddd_architecture(root_path, session, change_set_id)
    _write_session(root_path, session)
    return _result(root_path, session)


def restart_ddd_architecture(root: Path | str, change_set_id: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    event_state = session.get("event_storming")
    if not isinstance(event_state, dict) or not event_state.get("complete"):
        raise ValueError("event-storming gate has not passed")
    uc_ids = [
        uc_id
        for uc_id in event_state.get("uc_ids", [])
        if event_state.get("items", {}).get(uc_id, {}).get("status") == "complete"
    ]
    if not uc_ids:
        raise ValueError("no completed event-storming slices are available for DDD architecture")
    for uc_id in uc_ids:
        output = root_path / USE_CASE_SLICE_ROOT / uc_id / "ddd-design.md"
        if output.exists():
            output.unlink()
    session["ddd_architecture"] = _new_ddd_architecture_state(uc_ids)
    session["active_stage"] = "dddArchitecture"
    session["runtime_error"] = ""
    _advance_ddd_architecture(root_path, session, change_set_id)
    _write_session(root_path, session)
    return _result(root_path, session)


def advance_ddd_architecture(root: Path | str, change_set_id: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    state = session.get("ddd_architecture")
    if not isinstance(state, dict):
        raise ValueError("DDD architecture has not started")
    if _current_ddd_question(session):
        raise ValueError("answer the current DDD architecture question before continuing")
    _advance_ddd_architecture(root_path, session, change_set_id)
    _write_session(root_path, session)
    return _result(root_path, session)


def run_all_ddd_architecture(root: Path | str, change_set_id: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    event_state = session.get("event_storming")
    if not isinstance(event_state, dict) or not event_state.get("complete"):
        raise ValueError("event-storming gate has not passed")
    uc_ids = [
        uc_id
        for uc_id in event_state.get("uc_ids", [])
        if event_state.get("items", {}).get(uc_id, {}).get("status") == "complete"
    ]
    if not uc_ids:
        raise ValueError("no completed event-storming slices are available for DDD architecture")
    state = session.get("ddd_architecture")
    if not isinstance(state, dict) or state.get("uc_ids") != uc_ids:
        state = _new_ddd_architecture_state(uc_ids)
        session["ddd_architecture"] = state
    if _current_ddd_question(session):
        raise ValueError("answer the current DDD architecture question before running all substeps")
    session["active_stage"] = "dddArchitecture"
    remaining = _remaining_ddd_targets(state)
    if not remaining:
        state["complete"] = True
        state["status"] = "complete"
        state["current_uc"] = None
        state["current_step"] = None
        session["runtime_error"] = ""
        _write_session(root_path, session)
        return _result(root_path, session)
    _advance_all_ddd_architecture(root_path, session, change_set_id, remaining)
    _write_session(root_path, session)
    return _result(root_path, session)


def begin_run_all_ddd_architecture(root: Path | str, change_set_id: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    event_state = session.get("event_storming")
    if not isinstance(event_state, dict) or not event_state.get("complete"):
        raise ValueError("event-storming gate has not passed")
    uc_ids = [
        uc_id
        for uc_id in event_state.get("uc_ids", [])
        if event_state.get("items", {}).get(uc_id, {}).get("status") == "complete"
    ]
    if not uc_ids:
        raise ValueError("no completed event-storming slices are available for DDD architecture")
    state = session.get("ddd_architecture")
    if not isinstance(state, dict) or state.get("uc_ids") != uc_ids:
        state = _new_ddd_architecture_state(uc_ids)
        session["ddd_architecture"] = state
    if _current_ddd_question(session):
        raise ValueError("answer the current DDD architecture question before running all substeps")
    remaining = _remaining_ddd_targets(state)
    if not remaining:
        state["complete"] = True
        state["status"] = "complete"
        state["current_uc"] = None
        state["current_step"] = None
        session["runtime_error"] = ""
    else:
        first = remaining[0]
        state["run_all_targets"] = remaining
        state["current_uc"] = first["uc_id"]
        state["current_step"] = first["step_id"]
        state["status"] = "running"
        state["complete"] = False
        for target in remaining:
            item = state["items"][target["uc_id"]]
            step = item["steps"][target["step_id"]]
            item["status"] = "running"
            step["status"] = "running"
            step["error"] = ""
            step["current_question"] = None
        session["runtime_error"] = ""
    session["active_stage"] = "dddArchitecture"
    _write_session(root_path, session)
    return _result(root_path, session)


def finish_run_all_ddd_architecture(root: Path | str, change_set_id: str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    state = session.get("ddd_architecture")
    if not isinstance(state, dict):
        raise ValueError("DDD architecture has not started")
    targets = state.get("run_all_targets")
    if not isinstance(targets, list) or not targets:
        targets = _remaining_ddd_targets(state)
    _advance_all_ddd_architecture(root_path, session, change_set_id, targets)
    state.pop("run_all_targets", None)
    _write_session(root_path, session)
    return _result(root_path, session)


def rerun_ddd_architecture_step(
    root: Path | str,
    change_set_id: str,
    uc_id: str,
    step_id: str,
    user_prompt: str,
) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    state = session.get("ddd_architecture")
    if not isinstance(state, dict):
        raise ValueError("DDD architecture has not started")
    if _current_ddd_question(session):
        raise ValueError("answer the current DDD architecture question before rerunning a substep")
    item = state.get("items", {}).get(uc_id)
    if not isinstance(item, dict) or step_id not in item.get("steps", {}):
        raise ValueError("unknown DDD architecture substep")
    normalized_prompt = user_prompt.strip()
    if normalized_prompt:
        item["steps"][step_id].setdefault("rerun_prompts", []).append(normalized_prompt)
    item["steps"][step_id]["current_question"] = None
    state["status"] = "running"
    item["status"] = "running"
    session["active_stage"] = "dddArchitecture"
    _advance_ddd_architecture(root_path, session, change_set_id, uc_id=uc_id, step_id=step_id)
    _write_session(root_path, session)
    return _result(root_path, session)


def answer_ddd_architecture(
    root: Path | str,
    change_set_id: str,
    uc_id: str,
    step_id: str,
    answer: str,
) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_or_recover_session(root_path)
    state = session.get("ddd_architecture")
    if not isinstance(state, dict) or state.get("current_uc") != uc_id:
        raise ValueError("no active DDD architecture question for use case")
    item = state.get("items", {}).get(uc_id, {})
    step = item.get("steps", {}).get(step_id, {})
    question = step.get("current_question")
    normalized_answer = answer.strip()
    if step_id != state.get("current_step") or not isinstance(question, dict) or not normalized_answer:
        raise ValueError("answer is required for the current DDD architecture question")
    step.setdefault("clarifications", []).append(
        {
            "questions": [{"question": str(question.get("question", "")), "recommended": str(question.get("recommended", ""))}],
            "answer": normalized_answer,
        }
    )
    step["current_question"] = None
    _advance_ddd_architecture(root_path, session, change_set_id, uc_id=uc_id, step_id=step_id)
    _write_session(root_path, session)
    return _result(root_path, session)


def load_harvest_ui(root: Path | str) -> HarvestUiResult:
    root_path = Path(root)
    session = _load_session(root_path)
    if session is None:
        session = _session_from_requirements_doc(root_path)
    if session is None:
        session = _new_session("")
    else:
        _normalize_session(session)
        _sync_use_case_readiness(root_path, session)
        _resume_if_needed(root_path, session)
    return _result(root_path, session)


def save_changeset_harvest_ui(root: Path | str, change_set_id: str) -> None:
    root_path = Path(root)
    _require_active_changeset(root_path, change_set_id)
    session = _load_session(root_path)
    if session is None:
        raise ValueError("harvest session has not started")
    _write_changeset_harvest_snapshot(root_path, change_set_id, session)


def _write_changeset_harvest_snapshot(root: Path, change_set_id: str, session: dict[str, Any]) -> None:
    scoped_root = _changeset_session_root(root, change_set_id)
    scoped_root.mkdir(parents=True, exist_ok=True)
    (scoped_root / "harvest-session.json").write_text(
        json.dumps(session, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    for artifact in (REQUIREMENTS_PATH, UBIQUITOUS_LANGUAGE_PATH, CONTEXT_PATH):
        _copy_optional_artifact(root / artifact, scoped_root / artifact)
    use_cases_started = (
        session.get("active_stage") == "useCases"
        or session.get("use_cases_ready")
        or session.get("use_case_current_question")
        or session.get("use_case_clarifications")
    )
    if use_cases_started:
        _copy_optional_artifact(root / USE_CASES_PATH, scoped_root / USE_CASES_PATH)
        _copy_scoped_use_case_outputs(root, scoped_root, session)
        if isinstance(session.get("ddd_architecture"), dict):
            _copy_optional_artifact(root / "ARCHITECTURE.md", scoped_root / "ARCHITECTURE.md")
    else:
        use_case_document = scoped_root / USE_CASES_PATH
        if use_case_document.exists():
            use_case_document.unlink()
        use_case_slices = scoped_root / USE_CASE_SLICE_ROOT
        if use_case_slices.exists():
            shutil.rmtree(use_case_slices)


def load_changeset_harvest_ui(root: Path | str, change_set_id: str) -> HarvestUiResult:
    root_path = Path(root)
    _require_active_changeset(root_path, change_set_id)
    scoped_root = _changeset_session_root(root_path, change_set_id)
    session_path = scoped_root / "harvest-session.json"
    if not session_path.exists():
        session = _recover_changeset_session(root_path, change_set_id)
        _write_changeset_harvest_snapshot(root_path, change_set_id, session)
    else:
        session = json.loads(session_path.read_text(encoding="utf-8"))
    _normalize_session(session)
    _normalize_resumed_stage(session)
    return _result(root_path, session, artifact_root=scoped_root)


def activate_changeset_harvest_ui(root: Path | str, change_set_id: str) -> None:
    root_path = Path(root)
    load_changeset_harvest_ui(root_path, change_set_id)
    scoped_root = _changeset_session_root(root_path, change_set_id)
    session_path = scoped_root / "harvest-session.json"
    _copy_optional_artifact(session_path, root_path / SESSION_PATH)
    for artifact in (REQUIREMENTS_PATH, UBIQUITOUS_LANGUAGE_PATH, CONTEXT_PATH, USE_CASES_PATH):
        _copy_optional_artifact(scoped_root / artifact, root_path / artifact)
    _copy_optional_tree(
        scoped_root / USE_CASE_SLICE_ROOT,
        root_path / USE_CASE_SLICE_ROOT,
        replace=False,
    )


def _new_session(prompt: str) -> dict[str, Any]:
    return {
        "initial_prompt": prompt.strip(),
        "clarifications": [],
        "current_question": None,
        "current_questions": [],
        "pending_questions": [],
        "requirements_gate_passed": False,
        "language_gate_passed": False,
        "active_stage": "requirements",
        "use_cases_ready": False,
        "runtime_error": "",
        "draft_context_markdown": "",
        "draft_requirements_markdown": "",
        "use_case_clarifications": [],
        "use_case_current_question": None,
        "use_case_current_questions": [],
        "use_case_pending_questions": [],
        "event_storming": None,
        "ddd_architecture": None,
    }


def _workflow_projection() -> dict[str, Any]:
    return {
        "stages": [
            {"id": "requirements", "label": "Requirements", "document": str(REQUIREMENTS_PATH)},
            {"id": "ubiquitousLanguage", "label": "Ubiquitous Language", "document": str(UBIQUITOUS_LANGUAGE_PATH)},
            {"id": "useCases", "label": "Use Cases", "document": str(USE_CASES_PATH)},
            {"id": "eventStorming", "label": "Event Storming", "document": ""},
            {"id": "dddArchitecture", "label": "DDD Architecture", "document": ""},
        ]
    }


def _load_or_recover_session(root: Path) -> dict[str, Any]:
    session = _load_session(root)
    if session is None:
        session = _session_from_requirements_doc(root)
    if session is None:
        raise ValueError("harvest session has not started")
    _normalize_session(session)
    _sync_use_case_readiness(root, session)
    return session


def _normalize_session(session: dict[str, Any]) -> None:
    if "language_gate_passed" not in session:
        session["language_gate_passed"] = bool(
            session.get("use_cases_ready")
            or session.get("use_case_current_question")
            or session.get("use_case_clarifications")
            or session.get("active_stage") in {"useCases", "eventStorming", "dddArchitecture"}
        )
    session["clarifications"] = [
        _normalize_clarification(item)
        for item in session.get("clarifications", [])
    ]
    session.setdefault("pending_questions", [])
    session.setdefault("draft_context_markdown", "")
    session.setdefault("draft_requirements_markdown", "")
    session.setdefault("use_case_clarifications", [])
    session.setdefault("use_case_current_question", None)
    session.setdefault("use_case_current_questions", [])
    session.setdefault("use_case_pending_questions", [])
    session.setdefault("event_storming", None)
    session.setdefault("ddd_architecture", None)
    current = session.get("current_question")
    current_questions = [
        item
        for item in (session.get("current_questions") or [])
        if isinstance(item, dict) and item.get("question")
    ][:3]
    if current is None and current_questions:
        session["current_question"] = current_questions[0]
    elif current and not current_questions:
        current_questions = [current]
    session["current_questions"] = current_questions
    use_case_current = session.get("use_case_current_question")
    use_case_current_questions = session.get("use_case_current_questions") or []
    if use_case_current is None and use_case_current_questions:
        session["use_case_current_question"] = use_case_current_questions[0]
    if session.get("use_case_current_question"):
        session["use_case_current_questions"] = [session["use_case_current_question"]]
    else:
        session["use_case_current_questions"] = []
    state = session.get("event_storming")
    if isinstance(state, dict):
        state.setdefault("uc_ids", [])
        state.setdefault("items", {})
        state.setdefault("current_uc", None)
        state.setdefault("completed_count", 0)
        state.setdefault("complete", False)
        state.setdefault("status", "pending")
    ddd_state = session.get("ddd_architecture")
    if isinstance(ddd_state, dict):
        ddd_state.setdefault("uc_ids", [])
        ddd_state.setdefault("items", {})
        ddd_state.setdefault("current_uc", None)
        ddd_state.setdefault("current_step", None)
        ddd_state.setdefault("completed_count", 0)
        ddd_state.setdefault("complete", False)
        ddd_state.setdefault("status", "pending")


def _load_session(root: Path) -> dict[str, Any] | None:
    path = root / SESSION_PATH
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _resume_if_needed(root: Path, session: dict[str, Any]) -> None:
    if session["requirements_gate_passed"]:
        return
    if session.get("current_question") or session.get("current_questions"):
        return
    if session.get("pending_questions"):
        _activate_next_pending_question(session)
        _write_session(root, session)
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
    gate_passed = _requirements_gate_passed_from_doc(text)
    use_cases_ready, _ = _validate_runtime_ready_use_case_slices(root)
    session = {
        "initial_prompt": initial_prompt,
        "clarifications": list(clarifications),
        "current_question": None,
        "current_questions": [],
        "pending_questions": [],
        "requirements_gate_passed": gate_passed,
        "language_gate_passed": use_cases_ready,
        "active_stage": "requirements",
        "use_cases_ready": use_cases_ready,
        "runtime_error": "",
        "use_case_clarifications": [],
        "use_case_current_question": None,
        "use_case_current_questions": [],
        "use_case_pending_questions": [],
        "event_storming": None,
        "ddd_architecture": None,
    }
    if session["use_cases_ready"]:
        session["active_stage"] = "useCases"
    elif session["requirements_gate_passed"]:
        session["active_stage"] = "ubiquitousLanguage"
    return session


def _session_from_active_changeset(root: Path, change_set_id: str) -> dict[str, Any] | None:
    path = root / "docs" / "changes" / "active" / f"{change_set_id}.md"
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    match = re.search(r"^- Request summary:\s*(.+)$", text, flags=re.MULTILINE)
    initial_prompt = match.group(1).strip() if match else change_set_id
    use_cases_ready, _ = _validate_runtime_ready_use_case_slices(root)
    session = _new_session(initial_prompt)
    session["requirements_gate_passed"] = (root / REQUIREMENTS_PATH).exists()
    session["language_gate_passed"] = (root / UBIQUITOUS_LANGUAGE_PATH).exists()
    session["use_cases_ready"] = use_cases_ready
    if use_cases_ready or (root / USE_CASES_PATH).exists():
        session["active_stage"] = "useCases"
    elif session["language_gate_passed"]:
        session["active_stage"] = "useCases"
    elif session["requirements_gate_passed"]:
        session["active_stage"] = "ubiquitousLanguage"
    return session


def _requirements_gate_passed_from_doc(text: str) -> bool:
    if "Current gate: Passed" in text:
        return True
    required_sections = (
        "Business Policy Decisions Needed",
        "Foundational Technology Decisions Needed",
    )
    for heading in required_sections:
        match = re.search(
            rf"^## \d+\. {re.escape(heading)}\s*$([\s\S]*?)(?=^## |\Z)",
            text,
            flags=re.MULTILINE,
        )
        if match is None or not re.search(r"^\s*-\s+None(?:\.|\s|$)", match.group(1), flags=re.MULTILINE):
            return False
    return True


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
        for question in questions:
            rows.append({"questions": [question], "answer": answer})
    return rows


def _split_recovered_questions(text: str) -> list[str]:
    parts = [part.strip() for part in text.split("<br>") if part.strip()]
    if not parts:
        return [text.strip()] if text.strip() else []
    return [re.sub(r"^\d+\.\s*", "", part).strip() for part in parts]


def _normalize_clarification(item: dict[str, Any]) -> dict[str, Any]:
    if "questions" in item and isinstance(item["questions"], list):
        return {
            "questions": [
                {
                    "question": str(question.get("question", "")),
                    "recommended": str(question.get("recommended", "")),
                }
                for question in item["questions"]
            ],
            "answer": str(item.get("answer", "")),
        }
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


def _result(root: Path, session: dict[str, Any], *, artifact_root: Path | None = None) -> HarvestUiResult:
    documents_root = artifact_root or root
    session_started = bool(session["initial_prompt"])
    requirements_markdown = (
        _read_optional(documents_root / REQUIREMENTS_PATH) if session_started else ""
    )
    context_markdown = _read_language_artifact(documents_root) if session_started else ""
    use_cases_markdown = (
        _read_optional(documents_root / USE_CASES_PATH)
        if session_started and session.get("use_cases_ready")
        else ""
    )
    gate_passed = bool(session["requirements_gate_passed"])
    language_gate_passed = bool(session.get("language_gate_passed"))
    event_storming = _event_storming_payload(documents_root, session)
    ddd_architecture = _ddd_architecture_payload(documents_root, session)
    status = "idle" if not session_started else (
        "ddd_architecture_ready" if ddd_architecture.get("complete") else (
        "ddd_architecture_running" if session.get("active_stage") == "dddArchitecture" else (
        "event_storming_ready" if event_storming.get("complete") else (
        "event_storming_running" if session.get("active_stage") == "eventStorming" else (
        "use_cases_ready" if session.get("use_cases_ready") else (
            "language_passed" if language_gate_passed else (
                "language_running" if gate_passed else "requirements_running"
            )
        )))))
    )
    if session_started and not gate_passed:
        current_question = _current_question(session)
    elif session_started and language_gate_passed and not session.get("use_cases_ready"):
        current_question = _current_use_case_question(session)
    elif session_started and session.get("active_stage") == "eventStorming":
        current_question = _current_event_storming_question(session)
    elif session_started and session.get("active_stage") == "dddArchitecture":
        current_question = _current_ddd_question(session)
    else:
        current_question = None
    if session_started and not gate_passed:
        current_questions = tuple(_current_questions(session))
    else:
        current_questions = (current_question,) if current_question else ()
    return HarvestUiResult(
        initial_prompt=session["initial_prompt"],
        status=status,
        active_stage=session["active_stage"],
        requirements_markdown=requirements_markdown,
        context_markdown=context_markdown,
        use_cases_markdown=use_cases_markdown,
        clarifications=tuple(session["clarifications"]),
        current_question=current_question,
        current_questions=current_questions,
        requirements_gate_passed=gate_passed,
        language_gate_passed=language_gate_passed,
        use_cases_ready=bool(session.get("use_cases_ready")),
        event_storming=event_storming,
        ddd_architecture=ddd_architecture,
        runtime_error=str(session.get("runtime_error", "")),
        workflow=_workflow_projection(),
    )


def _changeset_session_root(root: Path, change_set_id: str) -> Path:
    if not re.fullmatch(r"CHG-[A-Za-z0-9-]+", change_set_id):
        raise ValueError("invalid ChangeSet id")
    return root / CHANGESET_SESSION_ROOT / change_set_id


def _require_active_changeset(root: Path, change_set_id: str) -> None:
    _changeset_session_root(root, change_set_id)
    if not (root / "docs/changes/active" / f"{change_set_id}.md").exists():
        raise ValueError(f"Active ChangeSet does not exist: {change_set_id}.")


def _recover_changeset_session(root: Path, change_set_id: str) -> dict[str, Any]:
    active_ids = sorted(
        path.stem
        for path in (root / "docs/changes/active").glob("CHG-*.md")
        if re.fullmatch(r"CHG-[A-Za-z0-9-]+", path.stem)
    )
    if active_ids != [change_set_id]:
        raise ValueError(f"Resume unavailable for {change_set_id}: no saved workflow state.")
    session = _session_from_requirements_doc(root) or _session_from_active_changeset(root, change_set_id)
    if session is None:
        raise ValueError(f"Resume unavailable for {change_set_id}: no saved workflow state.")
    _normalize_session(session)
    return session


def _copy_optional_artifact(source: Path, target: Path) -> None:
    if source.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    elif target.exists():
        target.unlink()


def _copy_optional_tree(source: Path, target: Path, *, replace: bool = True) -> None:
    if replace and target.exists():
        shutil.rmtree(target)
    if source.exists():
        shutil.copytree(source, target, dirs_exist_ok=not replace)


def _copy_scoped_use_case_outputs(root: Path, scoped_root: Path, session: dict[str, Any]) -> None:
    target_root = scoped_root / USE_CASE_SLICE_ROOT
    if target_root.exists():
        shutil.rmtree(target_root)
    uc_ids = _parse_canonical_use_case_ids(_read_optional(root / USE_CASES_PATH))
    event_items = (session.get("event_storming") or {}).get("items", {})
    ddd_items = (session.get("ddd_architecture") or {}).get("items", {})
    for uc_id in uc_ids:
        for name in ("use-case.md", "e2e-goal.md"):
            _copy_optional_artifact(
                root / USE_CASE_SLICE_ROOT / uc_id / name,
                target_root / uc_id / name,
            )
        if event_items.get(uc_id, {}).get("status") == "complete":
            _copy_optional_artifact(
                root / USE_CASE_SLICE_ROOT / uc_id / "event-storming.md",
                target_root / uc_id / "event-storming.md",
            )
        if any(
            step.get("status") == "complete"
            for step in ddd_items.get(uc_id, {}).get("steps", {}).values()
        ):
            _copy_optional_artifact(
                root / USE_CASE_SLICE_ROOT / uc_id / "ddd-design.md",
                target_root / uc_id / "ddd-design.md",
            )


def _normalize_resumed_stage(session: dict[str, Any]) -> None:
    if not session.get("requirements_gate_passed"):
        session["active_stage"] = "requirements"
        session["use_cases_ready"] = False
        return
    if not session.get("language_gate_passed"):
        session["active_stage"] = "ubiquitousLanguage"
        session["use_cases_ready"] = False
        return
    if isinstance(session.get("ddd_architecture"), dict):
        session["active_stage"] = "dddArchitecture"
    elif isinstance(session.get("event_storming"), dict):
        session["active_stage"] = "eventStorming"
    elif (
        session.get("use_cases_ready")
        or session.get("use_case_current_question")
        or session.get("use_case_clarifications")
        or session.get("active_stage") == "useCases"
    ):
        session["active_stage"] = "useCases"
    else:
        session["active_stage"] = "ubiquitousLanguage"


def _current_question(session: dict[str, Any]) -> dict[str, Any] | None:
    current = session.get("current_question")
    if isinstance(current, dict) and current.get("question"):
        return current
    current_questions = session.get("current_questions") or []
    if current_questions:
        return current_questions[0]
    return None


def _current_questions(session: dict[str, Any]) -> list[dict[str, Any]]:
    questions = [
        item
        for item in (session.get("current_questions") or [])
        if isinstance(item, dict) and item.get("question")
    ]
    if questions:
        return questions[:3]
    current = _current_question(session)
    return [current] if current else []


def _current_use_case_question(session: dict[str, Any]) -> dict[str, Any] | None:
    current = session.get("use_case_current_question")
    if isinstance(current, dict) and current.get("question"):
        return current
    current_questions = session.get("use_case_current_questions") or []
    if current_questions:
        return current_questions[0]
    return None


def _current_event_storming_question(session: dict[str, Any]) -> dict[str, Any] | None:
    state = session.get("event_storming")
    if not isinstance(state, dict):
        return None
    item = state.get("items", {}).get(state.get("current_uc"), {})
    current = item.get("current_question")
    return current if isinstance(current, dict) and current.get("question") else None


def _current_ddd_question(session: dict[str, Any]) -> dict[str, Any] | None:
    state = session.get("ddd_architecture")
    if not isinstance(state, dict):
        return None
    item = state.get("items", {}).get(state.get("current_uc"), {})
    step = item.get("steps", {}).get(state.get("current_step"), {})
    current = step.get("current_question")
    return current if isinstance(current, dict) and current.get("question") else None


def _activate_next_pending_question(session: dict[str, Any]) -> None:
    pending = list(session.get("pending_questions") or [])
    if not pending:
        session["current_question"] = None
        session["current_questions"] = []
        session["pending_questions"] = []
        return
    next_question = pending.pop(0)
    session["current_question"] = next_question
    session["current_questions"] = [next_question]
    session["pending_questions"] = pending


def _activate_next_use_case_pending_question(session: dict[str, Any]) -> None:
    pending = list(session.get("use_case_pending_questions") or [])
    if not pending:
        session["use_case_current_question"] = None
        session["use_case_current_questions"] = []
        session["use_case_pending_questions"] = []
        return
    next_question = pending.pop(0)
    session["use_case_current_question"] = next_question
    session["use_case_current_questions"] = [next_question]
    session["use_case_pending_questions"] = pending


def _advance_grill_me(root: Path, session: dict[str, Any]) -> None:
    result = _run_grill_me(root, session)
    requirements_markdown = str(result.get("requirements_markdown", "") or "")
    if requirements_markdown:
        session["draft_requirements_markdown"] = requirements_markdown
    filtered_questions = _filter_new_questions(result["questions"], session)
    if result["complete"]:
        session["requirements_gate_passed"] = True
        session["current_question"] = None
        session["current_questions"] = []
        session["pending_questions"] = []
    else:
        if not filtered_questions:
            session["requirements_gate_passed"] = True
            session["current_question"] = None
            session["current_questions"] = []
            session["pending_questions"] = []
        else:
            filtered_questions = filtered_questions[:3]
            session["requirements_gate_passed"] = False
            session["current_question"] = filtered_questions[0]
            session["current_questions"] = filtered_questions
            session["pending_questions"] = []
    session["runtime_error"] = ""


def _advance_use_case_harvest(root: Path, session: dict[str, Any], idea: str) -> None:
    result = _run_use_case_harvest(root, session, idea)
    status = str(result.get("status", "")).strip().lower()
    if status == "complete":
        ready, error = _validate_runtime_ready_use_case_slices(root)
        if not ready:
            raise ValueError(f"use-case harvest reported complete but {error}")
        session["use_cases_ready"] = True
        session["use_case_current_question"] = None
        session["use_case_current_questions"] = []
        session["use_case_pending_questions"] = []
        session["event_storming"] = None
        session["ddd_architecture"] = None
        session["runtime_error"] = ""
        return
    if status == "blocked":
        blocker = str(result.get("blocker", "") or "use-case harvest blocked")
        if _is_ubiquitous_language_blocker(blocker):
            session["active_stage"] = "ubiquitousLanguage"
            session["language_gate_passed"] = False
            session["use_cases_ready"] = False
            session["use_case_current_question"] = None
            session["use_case_current_questions"] = []
            session["use_case_pending_questions"] = []
            session["runtime_error"] = blocker
            return
        raise ValueError(blocker)
    questions = _filter_new_use_case_questions(result.get("questions", []), session)
    if not questions:
        blocker = str(result.get("blocker", "") or "use-case harvest needs input but returned no new questions")
        raise ValueError(blocker)
    session["use_cases_ready"] = False
    session["use_case_current_question"] = questions[0]
    session["use_case_current_questions"] = [questions[0]]
    session["use_case_pending_questions"] = questions[1:]
    session["runtime_error"] = ""


def _is_ubiquitous_language_blocker(message: str) -> bool:
    normalized = message.casefold()
    return (
        "harness-ubiquitous-language" in normalized
        or "ubiquitous language" in normalized
        or "ubiquitous-language" in normalized
        or str(UBIQUITOUS_LANGUAGE_PATH).casefold() in normalized
    )


def _new_event_storming_state(uc_ids: list[str]) -> dict[str, Any]:
    return {
        "uc_ids": uc_ids,
        "items": {
            uc_id: {
                "status": "pending",
                "current_question": None,
                "clarifications": [],
                "review_feedback": [],
                "reviews": [],
                "error": "",
            }
            for uc_id in uc_ids
        },
        "current_uc": None,
        "completed_count": 0,
        "complete": False,
        "status": "pending",
    }


def _event_storming_payload(documents_root: Path, session: dict[str, Any]) -> dict[str, Any]:
    state = session.get("event_storming")
    if not isinstance(state, dict):
        return {
            "uc_ids": [],
            "items": {},
            "current_uc": None,
            "completed_count": 0,
            "total_count": 0,
            "complete": False,
            "status": "not_started",
        }
    payload = json.loads(json.dumps(state, ensure_ascii=False))
    payload["total_count"] = len(payload.get("uc_ids", []))
    for uc_id, item in payload.get("items", {}).items():
        item["document_id"] = f"event-storming:{uc_id}"
        if item.get("status") == "complete":
            item["markdown"] = _read_optional(
                documents_root / USE_CASE_SLICE_ROOT / uc_id / "event-storming.md"
            )
    return payload


def _advance_event_storming(
    root: Path,
    session: dict[str, Any],
    change_set_id: str,
    *,
    uc_id: str | None = None,
) -> None:
    state = session["event_storming"]
    target_id = uc_id
    if target_id is None:
        target_id = next(
            (
                item_id
                for item_id in state["uc_ids"]
                if state["items"][item_id]["status"] in {"pending", "error"}
            ),
            None,
        )
    if target_id is None:
        state["complete"] = True
        state["status"] = "complete"
        state["current_uc"] = None
        session["runtime_error"] = ""
        return
    item = state["items"][target_id]
    session["ddd_architecture"] = None
    state["current_uc"] = target_id
    state["status"] = "running"
    item["status"] = "running"
    item["error"] = ""
    output_path = root / USE_CASE_SLICE_ROOT / target_id / "event-storming.md"
    try:
        for _attempt in range(EVENT_STORMING_REVIEW_ATTEMPTS):
            if output_path.exists():
                output_path.unlink()
            result = _run_event_storming(root, session, change_set_id, target_id)
            status = str(result.get("status", "")).strip().lower()
            if status == "complete":
                ready, error = _validate_event_storming_slice(output_path)
                if not ready:
                    raise ValueError(f"event storming reported complete but {error}")
                review = _run_event_storming_content_review(
                    root,
                    session,
                    change_set_id,
                    target_id,
                    output_path,
                )
                item.setdefault("reviews", []).append(review)
                review_status = str(review.get("status", "")).strip().lower()
                if review_status == "complete":
                    item["status"] = "complete"
                    item["current_question"] = None
                    item["error"] = ""
                    state["completed_count"] = sum(
                        1 for value in state["items"].values() if value.get("status") == "complete"
                    )
                    state["complete"] = state["completed_count"] == len(state["uc_ids"])
                    state["status"] = "complete" if state["complete"] else "running"
                    session["runtime_error"] = ""
                    return
                if review_status == "needs_input":
                    questions = review.get("questions", [])
                    if not isinstance(questions, list) or not questions:
                        raise ValueError("event storming content review needs input but returned no question")
                    question = questions[0]
                    item.setdefault("review_feedback", []).append(_event_storming_review_feedback(review))
                    item["status"] = "needs_input"
                    item["current_question"] = {
                        "question": str(question.get("question", "")).strip(),
                        "recommended": str(question.get("recommended", "") or "").strip(),
                    }
                    state["status"] = "needs_input"
                    session["runtime_error"] = ""
                    return
                item.setdefault("review_feedback", []).append(_event_storming_review_feedback(review))
                continue
            if status == "blocked":
                raise ValueError(str(result.get("blocker", "") or "event storming blocked"))
            questions = result.get("questions", [])
            if not isinstance(questions, list) or not questions:
                raise ValueError("event storming needs input but returned no question")
            question = questions[0]
            item["status"] = "needs_input"
            item["current_question"] = {
                "question": str(question.get("question", "")).strip(),
                "recommended": str(question.get("recommended", "") or "").strip(),
            }
            state["status"] = "needs_input"
            session["runtime_error"] = ""
            return
        raise ValueError("event storming content review rejected corrected artifacts")
    except ValueError as exc:
        item["status"] = "error"
        item["error"] = str(exc)
        item["current_question"] = None
        state["status"] = "error"
        state["complete"] = False
        session["runtime_error"] = str(exc)


def _validate_event_storming_slice(path: Path) -> tuple[bool, str]:
    if not path.is_file():
        return False, f"missing output: {path}"
    text = path.read_text(encoding="utf-8")
    if _looks_like_placeholder(text):
        return False, f"unverified placeholder in {path}"
    if not re.search(r"^### \[Flow: [^\]]+\]\s*$", text, flags=re.MULTILINE):
        return False, f"no parseable flow in {path}"
    for marker, label in (("🟦", "command"), ("🟧", "event"), ("🟪", "policy")):
        if marker not in text:
            return False, f"missing {label} sticky in {path}"
    return True, ""


def _new_ddd_architecture_state(uc_ids: list[str]) -> dict[str, Any]:
    return {
        "uc_ids": uc_ids,
        "items": {
            uc_id: {
                "status": "pending",
                "impact": {},
                "steps": {
                    step_id: {
                        "label": label,
                        "status": "pending",
                        "current_question": None,
                        "clarifications": [],
                        "error": "",
                    }
                    for step_id, label in DDD_STEPS
                },
            }
            for uc_id in uc_ids
        },
        "current_uc": uc_ids[0] if uc_ids else None,
        "current_step": DDD_STEPS[0][0] if uc_ids else None,
        "completed_count": 0,
        "complete": False,
        "status": "pending",
    }


def _ddd_architecture_payload(documents_root: Path, session: dict[str, Any]) -> dict[str, Any]:
    state = session.get("ddd_architecture")
    if not isinstance(state, dict):
        return {
            "uc_ids": [],
            "items": {},
            "current_uc": None,
            "current_step": None,
            "completed_count": 0,
            "total_count": 0,
            "complete": False,
            "status": "not_started",
            "step_order": [{"id": step_id, "label": label} for step_id, label in DDD_STEPS],
        }
    payload = json.loads(json.dumps(state, ensure_ascii=False))
    payload["total_count"] = len(payload.get("uc_ids", [])) * len(DDD_STEPS)
    payload["step_order"] = [{"id": step_id, "label": label} for step_id, label in DDD_STEPS]
    for uc_id, item in payload.get("items", {}).items():
        if any(step.get("status") == "complete" for step in item.get("steps", {}).values()):
            item["document_id"] = f"ddd-design:{uc_id}"
            item["markdown"] = _read_optional(
                documents_root / USE_CASE_SLICE_ROOT / uc_id / "ddd-design.md"
            )
    return payload


def _remaining_ddd_targets(state: dict[str, Any]) -> list[dict[str, str]]:
    targets: list[dict[str, str]] = []
    for uc_id in state.get("uc_ids", []):
        item = state.get("items", {}).get(uc_id, {})
        steps = item.get("steps", {})
        for step_id, label in DDD_STEPS:
            status = steps.get(step_id, {}).get("status")
            if status in {"pending", "running", "error", "stale"}:
                targets.append({"uc_id": str(uc_id), "step_id": step_id, "label": label})
    return targets


def _refresh_ddd_completion(state: dict[str, Any]) -> None:
    completed_count = 0
    running_count = 0
    needs_input_count = 0
    error_count = 0
    for uc_id in state.get("uc_ids", []):
        item = state.get("items", {}).get(uc_id, {})
        steps = item.get("steps", {})
        all_done = all(steps.get(step_id, {}).get("status") == "complete" for step_id, _label in DDD_STEPS)
        if isinstance(item, dict):
            statuses = [steps.get(step_id, {}).get("status") for step_id, _label in DDD_STEPS]
            if all_done:
                item["status"] = "complete"
            elif "error" in statuses:
                item["status"] = "error"
            elif "needs_input" in statuses:
                item["status"] = "needs_input"
            elif "running" in statuses:
                item["status"] = "running"
            else:
                item["status"] = "pending"
            running_count += sum(1 for status in statuses if status == "running")
            needs_input_count += sum(1 for status in statuses if status == "needs_input")
            error_count += sum(1 for status in statuses if status == "error")
        completed_count += sum(
            1
            for step_id, _label in DDD_STEPS
            if steps.get(step_id, {}).get("status") == "complete"
        )
    state["completed_count"] = completed_count
    total_count = len(state.get("uc_ids", [])) * len(DDD_STEPS)
    state["complete"] = completed_count == total_count
    if state["complete"]:
        state["status"] = "complete"
    elif error_count:
        state["status"] = "error"
    elif needs_input_count:
        state["status"] = "needs_input"
    elif running_count:
        state["status"] = "running"
    else:
        state["status"] = "pending"
    if state["complete"]:
        state["current_uc"] = None
        state["current_step"] = None


def _normalize_ddd_completed_targets(raw_targets: object) -> set[tuple[str, str]]:
    normalized: set[tuple[str, str]] = set()
    if not isinstance(raw_targets, list):
        return normalized
    for item in raw_targets:
        if not isinstance(item, dict):
            continue
        uc_id = str(item.get("uc_id", "") or "").strip()
        step_id = str(item.get("step_id", "") or "").strip()
        if uc_id and step_id:
            normalized.add((uc_id, step_id))
    return normalized


def _advance_all_ddd_architecture(
    root: Path,
    session: dict[str, Any],
    change_set_id: str,
    targets: list[dict[str, str]],
) -> None:
    state = session["ddd_architecture"]
    first = targets[0]
    state["current_uc"] = first["uc_id"]
    state["current_step"] = first["step_id"]
    state["status"] = "running"
    for target in targets:
        item = state["items"][target["uc_id"]]
        step = item["steps"][target["step_id"]]
        item["status"] = "running"
        step["status"] = "running"
        step["error"] = ""
        step["current_question"] = None
    try:
        result = _run_all_ddd_architecture_agent(root, session, change_set_id, targets)
        status = str(result.get("status", "")).strip().lower()
        completed_targets = (
            {(target["uc_id"], target["step_id"]) for target in targets}
            if status == "complete"
            else _normalize_ddd_completed_targets(result.get("completed_steps"))
        )
        for uc_id, step_id in completed_targets:
            if not any(target["uc_id"] == uc_id and target["step_id"] == step_id for target in targets):
                continue
            ready, error = _validate_ddd_design_slice(
                root / USE_CASE_SLICE_ROOT / uc_id / "ddd-design.md",
                step_id,
            )
            if not ready:
                raise ValueError(f"DDD architecture reported complete but {error}")
            step = state["items"][uc_id]["steps"][step_id]
            step["status"] = "complete"
            step["current_question"] = None
            step["error"] = ""
        if status == "complete":
            _refresh_ddd_completion(state)
            session["runtime_error"] = ""
            return
        if status == "blocked":
            raise ValueError(str(result.get("blocker", "") or "DDD architecture blocked"))
        question_target = result.get("current_target") if isinstance(result.get("current_target"), dict) else {}
        question_uc = str(question_target.get("uc_id") or first["uc_id"])
        question_step = str(question_target.get("step_id") or first["step_id"])
        if (question_uc, question_step) in completed_targets:
            remaining = [
                (target["uc_id"], target["step_id"])
                for target in targets
                if (target["uc_id"], target["step_id"]) not in completed_targets
            ]
            if remaining:
                question_uc, question_step = remaining[0]
        questions = result.get("questions", [])
        if not isinstance(questions, list) or not questions:
            raise ValueError("DDD architecture needs input but returned no question")
        question = questions[0]
        _refresh_ddd_completion(state)
        state["current_uc"] = question_uc
        state["current_step"] = question_step
        state["status"] = "needs_input"
        item = state["items"][question_uc]
        item["status"] = "needs_input"
        step = item["steps"][question_step]
        step["status"] = "needs_input"
        step["current_question"] = {
            "question": str(question.get("question", "")).strip(),
            "recommended": str(question.get("recommended", "") or "").strip(),
        }
        session["runtime_error"] = ""
    except ValueError as exc:
        _refresh_ddd_completion(state)
        state["current_uc"] = first["uc_id"]
        state["current_step"] = first["step_id"]
        state["status"] = "error"
        item = state["items"][first["uc_id"]]
        item["status"] = "error"
        step = item["steps"][first["step_id"]]
        step["status"] = "error"
        step["error"] = str(exc)
        step["current_question"] = None
        state["complete"] = False
        session["runtime_error"] = str(exc)


def _advance_ddd_architecture(
    root: Path,
    session: dict[str, Any],
    change_set_id: str,
    *,
    uc_id: str | None = None,
    step_id: str | None = None,
) -> None:
    state = session["ddd_architecture"]
    target_uc = uc_id
    target_step = step_id
    if target_uc is None:
        for candidate_uc in state["uc_ids"]:
            candidate = state["items"][candidate_uc]
            next_step = next(
                (
                    current_id for current_id, _label in DDD_STEPS
                    if candidate["steps"][current_id]["status"] in {"pending", "error", "stale"}
                ),
                None,
            )
            if next_step:
                target_uc, target_step = candidate_uc, next_step
                break
    if target_uc is None or target_step is None:
        state["complete"] = True
        state["status"] = "complete"
        state["current_uc"] = None
        state["current_step"] = None
        session["runtime_error"] = ""
        return
    item = state["items"][target_uc]
    step = item["steps"][target_step]
    state["current_uc"] = target_uc
    state["current_step"] = target_step
    state["status"] = "running"
    item["status"] = "running"
    step["status"] = "running"
    step["error"] = ""
    if target_step == DDD_STEPS[0][0] and not any(
        value.get("status") == "complete" for value in item["steps"].values()
    ):
        output = root / USE_CASE_SLICE_ROOT / target_uc / "ddd-design.md"
        if output.exists():
            output.unlink()
    try:
        result = _run_ddd_architecture(root, session, change_set_id, target_uc, target_step)
        status = str(result.get("status", "")).strip().lower()
        if status == "complete":
            ready, error = _validate_ddd_design_slice(
                root / USE_CASE_SLICE_ROOT / target_uc / "ddd-design.md",
                target_step,
            )
            if not ready:
                raise ValueError(f"DDD architecture reported complete but {error}")
            step["status"] = "complete"
            step["current_question"] = None
            step["error"] = ""
            if result.get("impact"):
                item["impact"] = result["impact"]
            all_done = all(value.get("status") == "complete" for value in item["steps"].values())
            item["status"] = "complete" if all_done else "pending"
            state["completed_count"] = sum(
                1
                for value in state["items"].values()
                for current in value["steps"].values()
                if current.get("status") == "complete"
            )
            state["complete"] = state["completed_count"] == len(state["uc_ids"]) * len(DDD_STEPS)
            state["status"] = "complete" if state["complete"] else "pending"
            session["runtime_error"] = ""
            return
        if status == "blocked":
            raise ValueError(str(result.get("blocker", "") or "DDD architecture blocked"))
        questions = result.get("questions", [])
        if not isinstance(questions, list) or not questions:
            raise ValueError("DDD architecture needs input but returned no question")
        question = questions[0]
        step["status"] = "needs_input"
        step["current_question"] = {
            "question": str(question.get("question", "")).strip(),
            "recommended": str(question.get("recommended", "") or "").strip(),
        }
        item["status"] = "needs_input"
        state["status"] = "needs_input"
        session["runtime_error"] = ""
    except ValueError as exc:
        step["status"] = "error"
        step["error"] = str(exc)
        step["current_question"] = None
        item["status"] = "error"
        state["status"] = "error"
        state["complete"] = False
        session["runtime_error"] = str(exc)


def _validate_ddd_design_slice(path: Path, completed_step: str) -> tuple[bool, str]:
    if not path.is_file():
        return False, f"missing output: {path}"
    text = path.read_text(encoding="utf-8")
    if _looks_like_placeholder(text):
        return False, f"unverified placeholder in {path}"
    table_error = _markdown_table_shape_error(text)
    if table_error:
        return False, f"malformed Markdown table in {path}: {table_error}"
    required = {
        "entity_vo": ("## Impact Assessment", "## Entity / Value Objects", "Evidence"),
        "behaviors": ("## Behaviors", "Signature", "Policy Evidence"),
        "application_flow": ("## Application Flow", "Signature", "Description", "Application Service"),
        "aggregates": ("## Aggregates", "Aggregate Root", "Atomic"),
        "bounded_contexts": ("## Bounded Contexts", "Communication Type"),
    }
    index = next(index for index, (step_id, _label) in enumerate(DDD_STEPS) if step_id == completed_step)
    terms = tuple(term for step_id, _label in DDD_STEPS[: index + 1] for term in required[step_id])
    missing = [term for term in terms if term not in text]
    if missing:
        return False, f"missing DDD structure in {path}: {', '.join(missing)}"
    if index >= 0 and not _ddd_entity_vo_has_typed_definition(text):
        return False, f"missing typed entity/VO attributes in {path}"
    if completed_step in {"aggregates", "bounded_contexts"} and not _ddd_aggregates_have_real_names(text):
        return False, f"missing explicit aggregate name in {path}"
    if completed_step == "bounded_contexts" and not any(
        value in text for value in ("internal_http", "domain_event", "shared_database", "None")
    ):
        return False, f"missing allowed communication type in {path}"
    return True, ""


def _markdown_table_shape_error(text: str) -> str:
    table_rows: list[tuple[int, str]] = []
    for line_no, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            table_rows.append((line_no, stripped))
            continue
        if table_rows:
            error = _markdown_table_rows_shape_error(table_rows)
            if error:
                return error
            table_rows = []
    if table_rows:
        return _markdown_table_rows_shape_error(table_rows)
    return ""


def _markdown_table_rows_shape_error(rows: list[tuple[int, str]]) -> str:
    if len(rows) < 2:
        return ""
    expected = len(_split_markdown_table_row(rows[0][1]))
    if expected < 2:
        return f"line {rows[0][0]} has too few columns"
    for line_no, row in rows[1:]:
        count = len(_split_markdown_table_row(row))
        if count != expected:
            return f"line {line_no} has {count} columns, expected {expected}; escape raw | as \\| inside table cells"
    return ""


def _split_markdown_table_row(row: str) -> list[str]:
    cells: list[str] = []
    current: list[str] = []
    escaped = False
    for char in row.strip()[1:-1]:
        if escaped:
            current.append(char)
            escaped = False
            continue
        if char == "\\":
            current.append(char)
            escaped = True
            continue
        if char == "|":
            cells.append("".join(current).strip())
            current = []
            continue
        current.append(char)
    cells.append("".join(current).strip())
    return cells


def _ddd_entity_vo_has_typed_definition(text: str) -> bool:
    section = _ddd_section_text(text, "## Entity / Value Objects")
    typed_columns = {
        "attributes / vos",
        "core attributes",
        "constructor / validation rules",
        "proposed definition",
        "proposed identity / state",
    }
    typed_indexes: list[int] = []
    for line in section.splitlines():
        if not line.startswith("|") or "---" in line:
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        lowered = [cell.lower() for cell in cells]
        if set(lowered) & typed_columns:
            typed_indexes = [index for index, cell in enumerate(lowered) if cell in typed_columns]
            continue
        candidates = [cells[index] for index in typed_indexes if index < len(cells)] if typed_indexes else cells[1:2]
        if any(_looks_like_typed_ddd_value(cell) for cell in candidates):
            return True
    return False


def _looks_like_typed_ddd_value(value: str) -> bool:
    if re.search(r"`?[a-z][A-Za-z0-9_]*`?\s*:\s*`?[A-Z][A-Za-z0-9_<>,\[\]?]*`?", value):
        return True
    return bool(re.search(r"`?[A-Z][A-Za-z0-9_<>]*(?:RelativePath|Path|Id|ID|String|Content|Name|List)?`?\s+[a-z][A-Za-z0-9_]*", value))


def _ddd_aggregates_have_real_names(text: str) -> bool:
    section = _ddd_section_text(text, "## Aggregates")
    aggregate_index: int | None = None
    saw_data_row = False
    for line in section.splitlines():
        if not line.startswith("|") or "---" in line:
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        lowered = [cell.lower() for cell in cells]
        if "aggregate" in lowered and ("aggregate root" in lowered or "atomic invariant" in lowered or "members" in lowered):
            aggregate_index = lowered.index("aggregate")
            continue
        if aggregate_index is None or aggregate_index >= len(cells):
            continue
        if not any(cells):
            continue
        saw_data_row = True
        name = cells[aggregate_index].strip("` ")
        if not name or name.lower() == "aggregate":
            return False
    return saw_data_row


def _ddd_section_text(text: str, heading: str) -> str:
    start = text.find(heading)
    if start < 0:
        return ""
    next_heading = re.search(r"^##\s+", text[start + len(heading) :], re.MULTILINE)
    if not next_heading:
        return text[start:]
    return text[start : start + len(heading) + next_heading.start()]


def _filter_new_questions(
    questions: list[dict[str, str]],
    session: dict[str, Any],
) -> list[dict[str, str]]:
    seen = _asked_question_keys(session)
    filtered: list[dict[str, str]] = []
    for question in questions:
        text = str(question.get("question", "")).strip()
        if not text:
            continue
        key = _question_key(text)
        if not key or key in seen:
            continue
        seen.add(key)
        filtered.append(question)
    return filtered


def _filter_new_use_case_questions(
    questions: Any,
    session: dict[str, Any],
) -> list[dict[str, str]]:
    if not isinstance(questions, list):
        return []
    seen = _asked_use_case_question_keys(session)
    filtered: list[dict[str, str]] = []
    for item in questions:
        if not isinstance(item, dict):
            continue
        text = str(item.get("question", "")).strip()
        if not text:
            continue
        key = _question_key(text)
        if not key or key in seen:
            continue
        seen.add(key)
        filtered.append(
            {
                "question": text,
                "recommended": str(item.get("recommended", "") or "").strip(),
            }
        )
    return filtered


def _asked_question_keys(session: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    for item in session.get("clarifications", []):
        for question in item.get("questions") or []:
            key = _question_key(str(question.get("question", "")))
            if key:
                keys.add(key)
    for question in session.get("pending_questions") or []:
        key = _question_key(str(question.get("question", "")))
        if key:
            keys.add(key)
    current = _current_question(session)
    if current:
        key = _question_key(str(current.get("question", "")))
        if key:
            keys.add(key)
    return keys


def _asked_use_case_question_keys(session: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    for item in session.get("use_case_clarifications", []):
        for question in item.get("questions") or []:
            key = _question_key(str(question.get("question", "")))
            if key:
                keys.add(key)
    for question in session.get("use_case_pending_questions") or []:
        key = _question_key(str(question.get("question", "")))
        if key:
            keys.add(key)
    current = _current_use_case_question(session)
    if current:
        key = _question_key(str(current.get("question", "")))
        if key:
            keys.add(key)
    return keys


def _question_key(text: str) -> str:
    normalized = re.sub(r"[^0-9a-zA-Z가-힣]+", "", text).lower()
    stop_words = (
        "무엇인가요",
        "무엇입니까",
        "무엇인지",
        "어떤",
        "알려주세요",
        "확인해주세요",
        "해주세요",
        "인가요",
        "입니까",
        "please",
        "what",
        "which",
        "tell",
        "about",
        "the",
        "a",
        "an",
    )
    for word in stop_words:
        normalized = normalized.replace(word, "")
    return normalized[:120]


def _run_grill_me(root: Path, session: dict[str, Any]) -> dict[str, Any]:
    grill_me_skill_path = root / GRILL_ME_SKILL_PATH
    agent_config_path = root / REQUIREMENTS_AGENT_CONFIG_PATH
    requirements_skill_path = root / REQUIREMENTS_SKILL_PATH
    if not grill_me_skill_path.exists():
        raise ValueError(f"missing required Grill-Me skill: {GRILL_ME_SKILL_PATH}")
    if not agent_config_path.exists():
        raise ValueError(f"missing requirements agent config: {REQUIREMENTS_AGENT_CONFIG_PATH}")
    if not requirements_skill_path.exists():
        raise ValueError(f"missing required requirements skill: {REQUIREMENTS_SKILL_PATH}")

    run_dir = root / ".harness/ui/grill-me-runs" / uuid4().hex[:12]
    run_dir.mkdir(parents=True, exist_ok=True)
    turn_result = _run_grill_me_question_turn(root, session, run_dir)
    if not turn_result["complete"]:
        return {
            "complete": False,
            "questions": turn_result["questions"],
            "requirements_markdown": "",
        }
    return _run_grill_me_finalizer(root, session, requirements_skill_path, run_dir)


def _run_interactive_agent(
    *,
    root: Path,
    step: Step,
    context: RunContext,
    step_dir: Path,
    agent_config_path: Path,
    skill_path: Path,
    prompt_suffix: str,
    label: str,
    timeout_error: str,
) -> str:
    if not agent_config_path.exists():
        raise ValueError(f"missing agent config: {agent_config_path.relative_to(root)}")
    if not skill_path.exists():
        raise ValueError(f"missing skill config: {skill_path.relative_to(root)}")

    result = ConfigurableCliAgentAdapter().run(
        AgentRunRequest(
            step=step,
            context=context,
            step_dir=step_dir,
            agent_config_path=agent_config_path,
            agent_config=_load_agent_config(agent_config_path),
            skill_path=skill_path,
            prompt_suffix=prompt_suffix,
        )
    )
    if result.status != StepStatus.SUCCEEDED:
        timeout_message = f"agent step timed out after {step.timeout_sec} seconds"
        if result.error == timeout_message:
            raise ValueError(timeout_error)
        raise ValueError(f"{label} failed: {result.error or result.status.value}")

    final_message_path = step_dir / "final-message.md"
    if not final_message_path.exists():
        raise ValueError(f"{label} failed: missing final message")
    return final_message_path.read_text(encoding="utf-8")


def _run_use_case_harvest(root: Path, session: dict[str, Any], idea: str) -> dict[str, Any]:
    agent_config_path = root / USE_CASE_AGENT_CONFIG_PATH
    skill_path = root / USE_CASE_SKILL_PATH
    if not agent_config_path.exists():
        raise ValueError(f"missing use-case agent config: {USE_CASE_AGENT_CONFIG_PATH}")
    if not skill_path.exists():
        raise ValueError(f"missing use-case skill config: {USE_CASE_SKILL_PATH}")

    run_id = f"interactive-use-cases-{uuid4().hex[:12]}"
    run_dir = root / ".harness/ui/use-case-runs" / run_id
    step_dir = run_dir / "step"
    step_dir.mkdir(parents=True, exist_ok=True)
    step = Step(
        id="harvest-use-cases",
        kind=StepKind.AGENT,
        name="Derive runtime-ready use case docs",
        agent_id="harness_usecases",
        skill_id="harness-usecases",
        inputs=(UBIQUITOUS_LANGUAGE_PATH, REQUIREMENTS_PATH),
        outputs=(USE_CASES_PATH, USE_CASE_SLICE_ROOT),
        timeout_sec=USE_CASE_DEFINITION_TIMEOUT_SEC,
        metadata={
            "stage": "harvest",
            "scope": "runtime_ready_use_cases",
            "interactive": True,
            "slice_outputs": {
                "root": str(USE_CASE_SLICE_ROOT),
                "required_per_use_case": ("use-case.md", "e2e-goal.md"),
            },
        },
    )
    context = RunContext(
        run_id=run_id,
        workflow_name="harvest-workflow",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=run_dir,
        metadata={
            "stage": "interactive_harvest",
            "initial_idea": idea or session.get("initial_prompt", ""),
            "interactive_turn": "use_cases",
        },
    )
    final_message = _run_interactive_agent(
        root=root,
        step=step,
        context=context,
        step_dir=step_dir,
        agent_config_path=agent_config_path,
        skill_path=skill_path,
        prompt_suffix=_use_case_turn_contract(session),
        label="use-case harvest execution",
        timeout_error=(
            f"use-case definition timed out after {USE_CASE_DEFINITION_TIMEOUT_SEC} seconds. "
            "Retry to continue from this stage."
        ),
    )
    return _parse_use_case_harvest_json(final_message)


def _run_event_storming(
    root: Path,
    session: dict[str, Any],
    change_set_id: str,
    uc_id: str,
) -> dict[str, Any]:
    agent_config_path = root / EVENT_STORMING_AGENT_CONFIG_PATH
    skill_path = root / EVENT_STORMING_SKILL_PATH
    if not agent_config_path.exists():
        raise ValueError(f"missing event-storming agent config: {EVENT_STORMING_AGENT_CONFIG_PATH}")
    if not skill_path.exists():
        raise ValueError(f"missing event-storming skill config: {EVENT_STORMING_SKILL_PATH}")

    run_id = f"interactive-event-storming-{uuid4().hex[:12]}"
    run_dir = root / ".harness/ui/event-storming-runs" / run_id
    step_dir = run_dir / "step"
    step_dir.mkdir(parents=True, exist_ok=True)
    output_path = USE_CASE_SLICE_ROOT / uc_id / "event-storming.md"
    step = Step(
        id=f"event-storming-{uc_id}",
        kind=StepKind.AGENT,
        name=f"Derive event storming for {uc_id}",
        agent_id="oracle",
        skill_id="harness-event-storming",
        inputs=(
            Path("docs/changes/active") / f"{change_set_id}.md",
            USE_CASE_SLICE_ROOT / uc_id / "use-case.md",
            USE_CASE_SLICE_ROOT / uc_id / "e2e-goal.md",
        ),
        outputs=(output_path,),
        timeout_sec=EVENT_STORMING_TIMEOUT_SEC,
        metadata={"stage": "event-storming", "scope": uc_id, "interactive": True},
    )
    context = RunContext(
        run_id=run_id,
        workflow_name="event-storming-workflow",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=run_dir,
        metadata={"stage": "event_storming", "change_set_id": change_set_id, "uc_id": uc_id},
    )
    item = session.get("event_storming", {}).get("items", {}).get(uc_id, {})
    final_message = _run_interactive_agent(
        root=root,
        step=step,
        context=context,
        step_dir=step_dir,
        agent_config_path=agent_config_path,
        skill_path=skill_path,
        prompt_suffix=_event_storming_turn_contract(change_set_id, uc_id, item),
        label="event-storming execution",
        timeout_error=(
            f"event storming timed out after {EVENT_STORMING_TIMEOUT_SEC} seconds. "
            "Retry to continue from this use case."
        ),
    )
    return _parse_event_storming_json(final_message)


def _event_storming_turn_contract(
    change_set_id: str,
    uc_id: str,
    item: dict[str, Any],
) -> str:
    return f"""## Interactive Event Storming Turn

Target ChangeSet: {change_set_id}
Target Use Case: {uc_id}

Return only JSON with keys: status, questions, changed_files, blocker.
- Return `needs_input` with exactly one question object only for event-storming modeling ambiguity when the approved use-case already contains the business policy.
- Return `blocked` when actor goal, success/failure policy, validation policy, retention/source policy, user-visible behavior, or any product/business policy is missing or contradictory; name the upstream stage that must resolve it.
- Return `complete` only after writing `docs/use-cases/{uc_id}/event-storming.md` with validated commands, events, policies, systems, external systems, and invariants.
- Return `blocked` only when existing inputs cannot be corrected by one user answer in this stage.
- Model only `{uc_id}`; use its goal or first actor action as initial command.

Event-storming answer history:
{json.dumps(item.get("clarifications", []), ensure_ascii=False, indent=2)}

Content review feedback:
{json.dumps(item.get("review_feedback", []), ensure_ascii=False, indent=2)}
"""


def _parse_event_storming_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if match is None:
            raise ValueError(f"event storming returned non-JSON output: {stripped}")
        data = json.loads(match.group(0))
    status = str(data.get("status", "") or "").strip().lower()
    if status not in {"needs_input", "complete", "blocked"}:
        raise ValueError(f"event storming returned invalid status: {status or '<empty>'}")
    questions = data.get("questions", [])
    if not isinstance(questions, list):
        raise ValueError("event storming returned invalid questions")
    return {
        "status": status,
        "questions": questions,
        "changed_files": [str(item) for item in data.get("changed_files", [])],
        "blocker": str(data.get("blocker", "") or ""),
    }


def _run_event_storming_content_review(
    root: Path,
    session: dict[str, Any],
    change_set_id: str,
    uc_id: str,
    output_path: Path,
) -> dict[str, Any]:
    agent_config_path = root / ARTIFACT_REVIEWER_AGENT_CONFIG_PATH
    skill_path = root / ARTIFACT_REVIEWER_SKILL_PATH
    if not agent_config_path.exists():
        raise ValueError(f"missing artifact reviewer agent config: {ARTIFACT_REVIEWER_AGENT_CONFIG_PATH}")
    if not skill_path.exists():
        raise ValueError(f"missing artifact reviewer skill config: {ARTIFACT_REVIEWER_SKILL_PATH}")

    run_id = f"interactive-event-storming-review-{uuid4().hex[:12]}"
    run_dir = root / ".harness/ui/event-storming-review-runs" / run_id
    step_dir = run_dir / "step"
    step_dir.mkdir(parents=True, exist_ok=True)
    review_output = Path(".harness/ui/event-storming-review-runs") / run_id / "review.md"
    step = Step(
        id=f"event-storming-content-review-{uc_id}",
        kind=StepKind.AGENT,
        name=f"Review event storming content for {uc_id}",
        agent_id="artifact_reviewer",
        skill_id="harness-artifact-reviewer",
        inputs=(
            Path("docs/changes/active") / f"{change_set_id}.md",
            USE_CASE_SLICE_ROOT / uc_id / "use-case.md",
            USE_CASE_SLICE_ROOT / uc_id / "e2e-goal.md",
            output_path.relative_to(root) if output_path.is_absolute() else output_path,
        ),
        outputs=(review_output,),
        timeout_sec=EVENT_STORMING_TIMEOUT_SEC,
        metadata={"stage": "event-storming-content-review", "scope": uc_id, "interactive": True},
    )
    context = RunContext(
        run_id=run_id,
        workflow_name="event-storming-content-review-workflow",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=run_dir,
        metadata={"stage": "event_storming_content_review", "change_set_id": change_set_id, "uc_id": uc_id},
    )
    final_message = _run_interactive_agent(
        root=root,
        step=step,
        context=context,
        step_dir=step_dir,
        agent_config_path=agent_config_path,
        skill_path=skill_path,
        prompt_suffix=_event_storming_content_review_contract(
            change_set_id,
            uc_id,
            review_output,
            session.get("event_storming", {}).get("items", {}).get(uc_id, {}),
        ),
        label="event-storming content review",
        timeout_error=(
            f"event storming content review timed out after {EVENT_STORMING_TIMEOUT_SEC} seconds. "
            "Retry to continue from this use case."
        ),
    )
    return _parse_event_storming_review_json(final_message)


def _event_storming_content_review_contract(
    change_set_id: str,
    uc_id: str,
    review_output: Path,
    item: dict[str, Any],
) -> str:
    return f"""## Interactive Event Storming Content Review

Target ChangeSet: {change_set_id}
Target Use Case: {uc_id}

Use `artifact_reviewer` and $harness-artifact-reviewer.
Review content correctness, completeness, contradictions, and stage-boundary fit. Do not only check Markdown shape. Do not edit event-storming artifacts.
Write one review report to `{review_output}`.

Return only JSON with keys: status, questions, review_file, findings, blocker.
- Return `complete` only when commands, events, policies, systems, external systems, and invariants match the ChangeSet, use-case slice, and E2E goal without contradictions.
- Return `needs_input` only when a content issue requires a user answer inside the event-storming boundary.
- Return `blocked` when content is wrong, contradictory, missing required event-storming elements, or violates stage boundaries and can be corrected by rerunning event storming with findings.
- Findings must name exact wrong or missing content so the next event-storming turn can fix it.

Previous review feedback:
{json.dumps(item.get("review_feedback", []), ensure_ascii=False, indent=2)}
"""


def _parse_event_storming_review_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if match is None:
            raise ValueError(f"event storming content review returned non-JSON output: {stripped}")
        data = json.loads(match.group(0))
    if not isinstance(data, dict):
        raise ValueError("event storming content review returned invalid JSON object")

    status = str(data.get("status", "") or "").strip().lower()
    if status not in {"needs_input", "complete", "blocked"}:
        raise ValueError(f"event storming content review returned invalid status: {status or '<empty>'}")
    raw_questions = data.get("questions", [])
    if not isinstance(raw_questions, list):
        raise ValueError("event storming content review returned invalid questions")
    questions: list[dict[str, str]] = []
    for item in raw_questions[:3]:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question", "") or "").strip()
        recommended = str(item.get("recommended", "") or "").strip()
        if question:
            questions.append({"question": question, "recommended": recommended})
    if status == "needs_input" and not questions:
        raise ValueError("event storming content review needs_input requires at least one question")

    raw_findings = data.get("findings", [])
    if not isinstance(raw_findings, list):
        raise ValueError("event storming content review returned invalid findings")
    return {
        "status": status,
        "questions": questions,
        "review_file": str(data.get("review_file", "") or "").strip(),
        "findings": [str(item) for item in raw_findings],
        "blocker": str(data.get("blocker", "") or "").strip(),
    }


def _event_storming_review_feedback(review: dict[str, Any]) -> dict[str, Any]:
    return {
        "status": str(review.get("status", "") or ""),
        "review_file": str(review.get("review_file", "") or ""),
        "findings": [str(item) for item in review.get("findings", [])],
        "blocker": str(review.get("blocker", "") or ""),
    }


def _run_ddd_architecture(
    root: Path,
    session: dict[str, Any],
    change_set_id: str,
    uc_id: str,
    step_id: str,
) -> dict[str, Any]:
    agent_config_path = root / DDD_AGENT_CONFIG_PATH
    skill_path = root / DDD_SKILL_PATH
    if not agent_config_path.exists():
        raise ValueError(f"missing DDD agent config: {DDD_AGENT_CONFIG_PATH}")
    if not skill_path.exists():
        raise ValueError(f"missing DDD skill config: {DDD_SKILL_PATH}")
    run_id = f"interactive-ddd-{uuid4().hex[:12]}"
    run_dir = root / ".harness/ui/ddd-runs" / run_id
    step_dir = run_dir / "step"
    step_dir.mkdir(parents=True, exist_ok=True)
    output_path = USE_CASE_SLICE_ROOT / uc_id / "ddd-design.md"
    step = Step(
        id=f"ddd-{uc_id}-{step_id}",
        kind=StepKind.AGENT,
        name=f"Derive DDD {step_id} for {uc_id}",
        agent_id="ddd_architect",
        skill_id="harness-ddd-design",
        inputs=(
            Path("docs/changes/active") / f"{change_set_id}.md",
            USE_CASE_SLICE_ROOT / uc_id / "use-case.md",
            USE_CASE_SLICE_ROOT / uc_id / "event-storming.md",
            USE_CASE_SLICE_ROOT / uc_id / "e2e-goal.md",
        ),
        outputs=(output_path,),
        timeout_sec=DDD_TIMEOUT_SEC,
        metadata={"stage": "ddd-architecture", "scope": uc_id, "substep": step_id, "interactive": True},
    )
    context = RunContext(
        run_id=run_id,
        workflow_name="ddd-architecture-workflow",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=run_dir,
        metadata={"stage": "ddd_architecture", "change_set_id": change_set_id, "uc_id": uc_id, "substep": step_id},
    )
    item = session["ddd_architecture"]["items"][uc_id]
    final_message = _run_interactive_agent(
        root=root,
        step=step,
        context=context,
        step_dir=step_dir,
        agent_config_path=agent_config_path,
        skill_path=skill_path,
        prompt_suffix=_ddd_turn_contract(change_set_id, uc_id, step_id, item),
        label="DDD architecture execution",
        timeout_error=(
            f"DDD architecture timed out after {DDD_TIMEOUT_SEC} seconds. "
            "Retry to continue from this substep."
        ),
    )
    return _parse_ddd_json(final_message)


def _run_all_ddd_architecture_agent(
    root: Path,
    session: dict[str, Any],
    change_set_id: str,
    targets: list[dict[str, str]],
) -> dict[str, Any]:
    agent_config_path = root / DDD_AGENT_CONFIG_PATH
    skill_path = root / DDD_SKILL_PATH
    if not agent_config_path.exists():
        raise ValueError(f"missing DDD agent config: {DDD_AGENT_CONFIG_PATH}")
    if not skill_path.exists():
        raise ValueError(f"missing DDD skill config: {DDD_SKILL_PATH}")
    run_id = f"interactive-ddd-run-all-{uuid4().hex[:12]}"
    run_dir = root / ".harness/ui/ddd-runs" / run_id
    step_dir = run_dir / "step"
    step_dir.mkdir(parents=True, exist_ok=True)
    uc_ids = sorted({target["uc_id"] for target in targets})
    step = Step(
        id="ddd-run-all-remaining",
        kind=StepKind.AGENT,
        name="Derive all remaining DDD substeps",
        agent_id="ddd_architect",
        skill_id="harness-ddd-design",
        inputs=tuple(
            [Path("docs/changes/active") / f"{change_set_id}.md"]
            + [
                path
                for uc_id in uc_ids
                for path in (
                    USE_CASE_SLICE_ROOT / uc_id / "use-case.md",
                    USE_CASE_SLICE_ROOT / uc_id / "event-storming.md",
                    USE_CASE_SLICE_ROOT / uc_id / "e2e-goal.md",
                )
            ]
        ),
        outputs=tuple(USE_CASE_SLICE_ROOT / uc_id / "ddd-design.md" for uc_id in uc_ids),
        timeout_sec=DDD_RUN_ALL_TIMEOUT_SEC,
        metadata={
            "stage": "ddd-architecture",
            "scope": "run-all-remaining",
            "substeps": targets,
            "interactive": True,
        },
    )
    context = RunContext(
        run_id=run_id,
        workflow_name="ddd-architecture-workflow",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=run_dir,
        metadata={
            "stage": "ddd_architecture",
            "change_set_id": change_set_id,
            "scope": "run-all-remaining",
            "substeps": targets,
        },
    )
    final_message = _run_interactive_agent(
        root=root,
        step=step,
        context=context,
        step_dir=step_dir,
        agent_config_path=agent_config_path,
        skill_path=skill_path,
        prompt_suffix=_ddd_run_all_contract(change_set_id, targets, session["ddd_architecture"]),
        label="DDD architecture run-all execution",
        timeout_error=(
            f"DDD architecture run-all timed out after {DDD_RUN_ALL_TIMEOUT_SEC} seconds. "
            "Retry to continue from the first unfinished substep."
        ),
    )
    return _parse_ddd_run_all_json(final_message)


def _ddd_turn_contract(change_set_id: str, uc_id: str, step_id: str, item: dict[str, Any]) -> str:
    return f"""## Interactive Phased DDD Architecture Turn

Target ChangeSet: {change_set_id}
Target Use Case: {uc_id}
Target Substep: {step_id}

Execute exactly this substep. Do not implement code or advance to another substep.
Update `docs/use-cases/{uc_id}/ddd-design.md` as one evolving document. Preserve prior completed sections.
The document must contain exactly one Mermaid graph in `## Architecture Visualization`, inside the `entity_vo` managed range; every visualization substep updates that same range and removes legacy visualization ranges after merging supported claims.
All Markdown tables must remain valid: every row in a table must have the same column count as the header; escape any literal pipe inside a cell as `\\|`, including pipes inside code spans or method/type examples.
Return only JSON with keys: status, questions, changed_files, blocker, impact.
- `needs_input`: exactly one modeling question.
- `complete`: current substep sections written with event-storming evidence.
- `blocked`: inputs cannot be corrected by one DDD answer.

Question boundary:
- Ask only when missing or contradictory slice evidence prevents this substep's DDD structural decision.
- Do not ask the user to choose a representation already implied by use-case, event-storming, or E2E evidence; derive it and cite the evidence.
- When slice evidence fully implies one model shape, choose that model shape without presenting alternatives as a question.
- Do not ask implementation strategy questions such as storage schema, UI layout, adapter shape, retry/cache/transaction details, or serialization mechanics; defer them to technical-decisions.

Substep requirements:
- `entity_vo`: write `## Impact Assessment` with exact columns `Element Type | Element | Status | Baseline Evidence | Event Storming Evidence`; every `## Entity / Value Objects` row must have one matching `Impact Assessment` row whose `Element Type` is only `Entity` or `Value Object`; write `## Entity / Value Objects` with exact columns `Entity | Attributes / VOs | Status | Previous Definition | Proposed Definition | Evidence`; classify new/modify/reuse using completed design docs and existing `ARCHITECTURE.md` as read-only baseline when present, read-only implementation fallback; `Status` is only lifecycle classification and must never be used as a visual model tag; include typed attributes/VO fields only, such as `notePath: WorkspaceRelativePath (required, evidence)` and `WorkspaceRelativePath {{ value: String }} (normalized inside workspace)`, without prose definitions inside the attributes cell; choose an explicit type for every attribute/field; write one attribute/field per line when multiple exist; an entity owns a VO only when a typed entity property uses a type documented as `Value Object` or an inline VO definition whose type is also used by that entity property; visualization must show model name, typed attributes rendered as `Type attributeName`, section tags for attributes/methods, method signatures, and entity-to-VO arrows generated from those typed properties. Aggregate labels and boundaries are added later by the `aggregates` substep into this same managed graph.
- `behaviors`: write `## Behaviors`; include entity/value-object/domain-service `Signature` and `Policy Evidence`; update the existing `entity_vo` managed visualization range into one combined graph; entity/value-object methods stay owned by their model card only; domain services appear as separate nodes in the same graph and, once Aggregate boundaries are known, must be inside their owning Aggregate boundary; do not create a separate Behaviors visualization subsection or `behaviors` managed range; if a legacy `behaviors` managed range exists, merge supported claims into the single shared graph and remove the legacy range.
- `application_flow`: write `## Application Flow` with exact columns `Application Service | Signature | Description | Calls | Evidence`; include the application service signature and a short prose description of logic flow; do not write pseudocode; do not create a separate Mermaid block or managed range; update the single `entity_vo` managed graph with application-service orchestration nodes/edges after the model/behavior/Aggregate area; Application Service nodes must remain outside Aggregate boundaries and connect to aggregate roots, Domain Services, or ports they call; Domain Service nodes must remain inside their owning Aggregate boundary.
- `aggregates`: write `## Aggregates`; choose explicit aggregate names; never leave the aggregate name empty and never use the literal placeholder `Aggregate`; include `Aggregate Root`, contained models, `Atomic` invariant evidence; do not create a separate aggregate Mermaid block; update the existing `entity_vo` managed visualization range so Aggregate name, boundary, root, contained Entity/VO nodes, and contained Domain Service nodes are visible in the same entity/VO graph; application service nodes belong outside Aggregate boundaries.
- `bounded_contexts`: write `## Bounded Contexts`; include `Communication Type` using only `internal_http`, `domain_event`, or `shared_database`; internal HTTP is a public client/API boundary, never internal-model access; do not create a separate Mermaid block or managed range; update the single `entity_vo` managed graph with bounded-context boundaries and communication-type edges after the application-flow area.

Additional user prompts for rerun:
{json.dumps(item.get("steps", {}).get(step_id, {}).get("rerun_prompts", []), ensure_ascii=False, indent=2)}

Prior step state:
{json.dumps(item, ensure_ascii=False, indent=2)}
"""


def _ddd_run_all_contract(
    change_set_id: str,
    targets: list[dict[str, str]],
    state: dict[str, Any],
) -> str:
    return f"""## Interactive Bulk DDD Architecture Turn

Target ChangeSet: {change_set_id}

Execute all listed remaining DDD substeps in this single agent turn, in the listed order.
Do not restart completed substeps that are not listed.
Do not implement production or test code.
Update each `docs/use-cases/<UC-ID>/ddd-design.md` as an evolving document and preserve already completed sections.
Each document must contain exactly one Mermaid graph in `## Architecture Visualization`, inside the `entity_vo` managed range; every visualization substep updates that same range and removes legacy visualization ranges after merging supported claims.
All Markdown tables must remain valid: every row in a table must have the same column count as the header; escape any literal pipe inside a cell as `\\|`, including pipes inside code spans or method/type examples.

Remaining substeps to execute:
{json.dumps(targets, ensure_ascii=False, indent=2)}

Return only JSON with keys: status, questions, changed_files, blocker, impact, completed_steps, current_target.
- `complete`: every listed substep completed and written.
- `needs_input`: stop at the first listed substep that cannot be completed without one modeling answer.
- `blocked`: inputs cannot be corrected by one DDD answer.
- `completed_steps`: array of objects with `uc_id` and `step_id` for listed substeps completed during this turn before any question/blocker.
- `current_target`: object with `uc_id` and `step_id` for the substep that needs input.

Question boundary:
- Ask only when missing or contradictory slice evidence prevents the current substep's DDD structural decision.
- Do not ask the user to choose a representation already implied by use-case, event-storming, or E2E evidence; derive it and cite the evidence.
- When slice evidence fully implies one model shape, choose that model shape without presenting alternatives as a question.
- Do not ask implementation strategy questions such as storage schema, UI layout, adapter shape, retry/cache/transaction details, or serialization mechanics; defer them to technical-decisions.

Substep requirements:
- `entity_vo`: write `## Impact Assessment` with exact columns `Element Type | Element | Status | Baseline Evidence | Event Storming Evidence`; every `## Entity / Value Objects` row must have one matching `Impact Assessment` row whose `Element Type` is only `Entity` or `Value Object`; write `## Entity / Value Objects` with exact columns `Entity | Attributes / VOs | Status | Previous Definition | Proposed Definition | Evidence`; classify new/modify/reuse using completed design docs and existing `ARCHITECTURE.md` as read-only baseline when present, read-only implementation fallback; `Status` is only lifecycle classification and must never be used as a visual model tag; include typed attributes/VO fields only, such as `notePath: WorkspaceRelativePath (required, evidence)` and `WorkspaceRelativePath {{ value: String }} (normalized inside workspace)`, without prose definitions inside the attributes cell; choose an explicit type for every attribute/field; write one attribute/field per line when multiple exist; an entity owns a VO only when a typed entity property uses a type documented as `Value Object` or an inline VO definition whose type is also used by that entity property; visualization must show model name, typed attributes rendered as `Type attributeName`, section tags for attributes/methods, method signatures, and entity-to-VO arrows generated from those typed properties. Aggregate labels and boundaries are added later by the `aggregates` substep into this same managed graph.
- `behaviors`: write `## Behaviors`; include entity/value-object/domain-service `Signature` and `Policy Evidence`; update the existing `entity_vo` managed visualization range into one combined graph; entity/value-object methods stay owned by their model card only; domain services appear as separate nodes in the same graph and, once Aggregate boundaries are known, must be inside their owning Aggregate boundary; do not create a separate Behaviors visualization subsection or `behaviors` managed range; if a legacy `behaviors` managed range exists, merge supported claims into the single shared graph and remove the legacy range.
- `application_flow`: write `## Application Flow` with exact columns `Application Service | Signature | Description | Calls | Evidence`; include the application service signature and a short prose description of logic flow; do not write pseudocode; do not create a separate Mermaid block or managed range; update the single `entity_vo` managed graph with application-service orchestration nodes/edges after the model/behavior/Aggregate area; Application Service nodes must remain outside Aggregate boundaries and connect to aggregate roots, Domain Services, or ports they call; Domain Service nodes must remain inside their owning Aggregate boundary.
- `aggregates`: write `## Aggregates`; choose explicit aggregate names; never leave the aggregate name empty and never use the literal placeholder `Aggregate`; include `Aggregate Root`, contained models, `Atomic` invariant evidence; do not create a separate aggregate Mermaid block; update the existing `entity_vo` managed visualization range so Aggregate name, boundary, root, contained Entity/VO nodes, and contained Domain Service nodes are visible in the same entity/VO graph; application service nodes belong outside Aggregate boundaries.
- `bounded_contexts`: write `## Bounded Contexts`; include `Communication Type` using only `internal_http`, `domain_event`, or `shared_database`; internal HTTP is a public client/API boundary, never internal-model access; do not create a separate Mermaid block or managed range; update the single `entity_vo` managed graph with bounded-context boundaries and communication-type edges after the application-flow area.

Prior DDD state:
{json.dumps(state, ensure_ascii=False, indent=2)}
"""


def _parse_ddd_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if match is None:
            raise ValueError(f"DDD architecture returned non-JSON output: {stripped}")
        data = json.loads(match.group(0))
    status = str(data.get("status", "") or "").strip().lower()
    if status not in {"needs_input", "complete", "blocked"}:
        raise ValueError(f"DDD architecture returned invalid status: {status or '<empty>'}")
    questions = data.get("questions", [])
    if not isinstance(questions, list):
        raise ValueError("DDD architecture returned invalid questions")
    impact = data.get("impact", {})
    return {
        "status": status,
        "questions": questions,
        "changed_files": [str(item) for item in data.get("changed_files", [])],
        "blocker": str(data.get("blocker", "") or ""),
        "impact": impact if isinstance(impact, dict) else {},
    }


def _parse_ddd_run_all_json(text: str) -> dict[str, Any]:
    data = _parse_ddd_json(text)
    stripped = text.strip()
    try:
        raw = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        raw = json.loads(match.group(0)) if match is not None else {}
    completed_steps = raw.get("completed_steps", [])
    if not isinstance(completed_steps, list):
        raise ValueError("DDD architecture run-all returned invalid completed_steps")
    current_target = raw.get("current_target", {})
    if current_target is not None and not isinstance(current_target, dict):
        raise ValueError("DDD architecture run-all returned invalid current_target")
    return {
        **data,
        "completed_steps": completed_steps,
        "current_target": current_target if isinstance(current_target, dict) else {},
    }


def _use_case_turn_contract(session: dict[str, Any]) -> str:
    return f"""## 10. Interactive Use-Case Harvest Turn

Return only JSON with keys: status, questions, changed_files, blocker.

Status rules:
- Return status `needs_input` when one focused user answer is required before use-case docs can be correct.
- Return status `complete` only after writing docs/design/유스케이스.md and every required docs/use-cases/<UC-ID>/use-case.md and docs/use-cases/<UC-ID>/e2e-goal.md file.
- Return status `blocked` only when the existing requirements/context inputs are not ready and no user answer in this stage can resolve it.

Question rules:
- When status is `needs_input`, include exactly one question object with keys question and recommended.
- Ask only the single highest-priority blocker for this turn.
- Do not queue non-blocking follow-up questions.
- Do not ask any question already present in Use-case answer history.
- If the answer history resolves enough ambiguity, write the use-case docs and return status `complete`.

Use-case answer history:
{json.dumps(session.get("use_case_clarifications", []), ensure_ascii=False, indent=2)}
"""


def _parse_use_case_harvest_json(text: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", stripped, flags=re.DOTALL)
        if match is None:
            raise ValueError(f"use-case harvest returned non-JSON output: {stripped}")
        data = json.loads(match.group(0))
    status = str(data.get("status", "") or "").strip().lower()
    if status not in {"needs_input", "complete", "blocked"}:
        raise ValueError(f"use-case harvest returned invalid status: {status or '<empty>'}")
    questions = data.get("questions", [])
    if not isinstance(questions, list):
        raise ValueError("use-case harvest returned invalid questions")
    changed_files = data.get("changed_files", [])
    if not isinstance(changed_files, list):
        raise ValueError("use-case harvest returned invalid changed_files")
    return {
        "status": status,
        "questions": questions,
        "changed_files": [str(item) for item in changed_files],
        "blocker": str(data.get("blocker", "") or ""),
    }


def _run_grill_me_question_turn(root: Path, session: dict[str, Any], run_dir: Path) -> dict[str, Any]:
    step_dir = run_dir / "question-turn"
    step_dir.mkdir(parents=True, exist_ok=True)
    step = Step(
        id="grill-me-question-turn",
        kind=StepKind.AGENT,
        name="Ask the next MVP-blocking requirements question",
        agent_id="requirements_interviewer",
        skill_id="grill-me",
        outputs=(),
        timeout_sec=300,
        metadata={"stage": "harvest", "scope": "requirements_clarification", "interactive": True},
    )
    context = RunContext(
        run_id=run_dir.name,
        workflow_name="requirements-harvest-workflow",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=run_dir,
        metadata={"stage": "interactive_harvest", "interactive_turn": "requirements_question"},
    )
    final_message = _run_interactive_agent(
        root=root,
        step=step,
        context=context,
        step_dir=step_dir,
        agent_config_path=root / REQUIREMENTS_AGENT_CONFIG_PATH,
        skill_path=root / GRILL_ME_SKILL_PATH,
        prompt_suffix=_grill_me_prompt(session),
        label="Grill-Me question turn",
        timeout_error="Grill-Me question turn timed out after 300 seconds. Retry to continue from this stage.",
    )
    return _parse_grill_me_turn_json(final_message)


def _run_grill_me_finalizer(
    root: Path,
    session: dict[str, Any],
    requirements_skill_path: Path,
    run_dir: Path,
) -> dict[str, Any]:
    step_dir = run_dir / "finalize"
    step_dir.mkdir(parents=True, exist_ok=True)
    step = Step(
        id="grill-me-finalize",
        kind=StepKind.AGENT,
        name="Draft requirements document from confirmed decisions",
        agent_id="requirements_interviewer",
        skill_id="harness-requirements",
        outputs=(REQUIREMENTS_PATH,),
        timeout_sec=300,
        metadata={"stage": "harvest", "scope": "requirements_finalization", "interactive": True},
    )
    context = RunContext(
        run_id=run_dir.name,
        workflow_name="requirements-harvest-workflow",
        mode=RunMode.APPLY,
        repo_root=root,
        workdir=root,
        run_dir=run_dir,
        metadata={"stage": "interactive_harvest", "interactive_turn": "requirements_finalization"},
    )
    final_message = _run_interactive_agent(
        root=root,
        step=step,
        context=context,
        step_dir=step_dir,
        agent_config_path=root / REQUIREMENTS_AGENT_CONFIG_PATH,
        skill_path=requirements_skill_path,
        prompt_suffix=_grill_me_finalization_prompt(session, requirements_skill_path, root / LANGUAGE_SKILL_PATH),
        label="Grill-Me finalization",
        timeout_error="Grill-Me finalization timed out after 300 seconds. Retry to continue from this stage.",
    )
    result = _parse_grill_me_json(final_message)
    if not result["requirements_markdown"]:
        if result["complete"] and not result["questions"] and _is_legacy_grill_me_result(final_message):
            return {"complete": True, "questions": []}
        raise ValueError("Grill-Me finalization returned incomplete requirements document")
    return result


def _is_legacy_grill_me_result(text: str) -> bool:
    try:
        data = json.loads(text.strip())
    except json.JSONDecodeError:
        return False
    if not isinstance(data, dict):
        return False
    return set(data.keys()).issubset({"complete", "questions", "question", "recommended"})


def _grill_me_prompt(session: dict[str, Any]) -> str:
    return f"""Use $grill-me to clarify requirements.

Return only JSON with keys: complete, questions.
When incomplete, return exactly 1 question in questions[].
Each question object must have keys: question, recommended.

Question rules:
- Ask exactly one focused question at a time.
- Keep the loop scoped to one coherent ChangeSet delivery outcome, not one arbitrary use case.
- The ChangeSet may include one through four closely related use cases when they are jointly required for the delivery outcome.
- Do not force the user to choose exactly one included use case or one smallest option unless the choices are truly mutually exclusive business policies.
- When asking about scope, allow an answer that combines related capabilities, identifies primary use cases, and lists supporting or prerequisite work.
- Do not ask any question already present in Compact Q/A history.
- Do not ask semantically equivalent questions to prior or active questions.
- If a previous answer is partial, ask only for the missing detail.
- Generate questions only from unresolved decisions.
- Ask only the highest-priority blocker for making the one coherent ChangeSet correct.
- Do not queue non-blocking follow-up questions.
- Do not ask detailed canonical naming, alias, forbidden-term, aggregate naming, domain event naming, or state-transition naming questions.
- Return complete=true once the confirmed decisions are sufficient to draft docs/design/요구사항.md.

Initial prompt:
{session["initial_prompt"]}

Compact Q/A history:
{json.dumps(_question_turn_history(session), ensure_ascii=False, indent=2)}
"""


def _grill_me_finalization_prompt(
    session: dict[str, Any],
    requirements_skill_path: Path,
    language_skill_path: Path,
) -> str:
    return f"""Use the confirmed requirement decisions below to draft the final harvest documents.

Return only JSON with keys: complete, questions, requirements_markdown.
Always include draft requirements_markdown that reflects the current confirmed state.
When incomplete, return exactly 1 question in questions[].
Each question object must have keys: question, recommended.

Document rules:
- In requirements_markdown, never use a clarification table column named `Answer`; use `Response`.
- requirements_markdown must follow harness-requirements and must not write or finalize `docs/design/ubiquitous-language.md`.
- Requirements may include Language Handoff Notes for the ubiquitous-language stage.
- Do not produce `context_markdown`; `docs/design/ubiquitous-language.md` belongs to harness-ubiquitous-language.

Initial prompt:
{session["initial_prompt"]}

Compact Q/A history:
{json.dumps(_question_turn_history(session), ensure_ascii=False, indent=2)}

Harness requirements standards:
- Load `{requirements_skill_path}`.
- Then read `.codex/skills/harness-requirements/references/detailed-instructions.md`.
- Do not load `{language_skill_path}` for requirements finalization.
- Read additional referenced files only if the current draft needs them.
"""


def _asked_questions(session: dict[str, Any]) -> list[dict[str, str]]:
    questions: list[dict[str, str]] = []
    for item in session.get("clarifications", []):
        answer = str(item.get("answer", ""))
        for question in item.get("questions") or []:
            questions.append(
                {
                    "question": str(question.get("question", "")),
                    "answer": answer,
                    "recommended": str(question.get("recommended", "")),
                    "status": "answered",
                }
            )
    return questions


def _question_turn_history(session: dict[str, Any]) -> list[dict[str, str]]:
    history = _asked_questions(session)
    current = _current_question(session)
    if current and str(current.get("question", "")).strip():
        history.append(
            {
                "question": str(current.get("question", "")),
                "answer": "",
                "recommended": str(current.get("recommended", "")),
                "status": "active",
            }
        )
    return history


def _parse_grill_me_turn_json(text: str) -> dict[str, Any]:
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
    for item in raw_questions[:1]:
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
    requirements_markdown = str(data.get("requirements_markdown", "") or "").strip()
    raw_questions = data.get("questions", [])
    if not isinstance(raw_questions, list):
        raise ValueError("Grill-Me returned invalid questions")
    questions = []
    for item in raw_questions[:1]:
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
    return {
        "complete": complete,
        "questions": questions,
        "requirements_markdown": requirements_markdown,
    }


def _extract_open_language_questions(markdown: str) -> list[str]:
    if not markdown.strip():
        return []
    match = re.search(
        r"^## 3\. Open Language Questions\s*$([\s\S]*?)(?=^##\s|\Z)",
        markdown,
        flags=re.MULTILINE,
    )
    if match is None:
        return []
    questions: list[str] = []
    for line in match.group(1).splitlines():
        stripped = line.strip()
        if not stripped.startswith("- "):
            continue
        question = stripped[2:].strip()
        if not question:
            continue
        if question.lower() in {"none", "none."}:
            continue
        questions.append(question)
    return questions


def _fallback_open_language_questions(open_questions: list[str]) -> list[dict[str, str]]:
    return [
        {
            "question": question,
            "recommended": "Confirm the canonical term or naming decision explicitly based on the current context draft.",
        }
        for question in open_questions[:3]
    ]


def _write_context_doc(root: Path, session: dict[str, Any]) -> None:
    path = root / UBIQUITOUS_LANGUAGE_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    markdown = str(session.get("draft_context_markdown", "") or "").strip()
    if markdown:
        path.write_text(markdown + "\n", encoding="utf-8")
        _mirror_legacy_context(root, markdown)
        return
    existing = _read_language_artifact(root).strip()
    if existing:
        path.write_text(existing + "\n", encoding="utf-8")
        _mirror_legacy_context(root, existing)
        return
    markdown = _fallback_context_markdown(session)
    path.write_text(markdown + "\n", encoding="utf-8")
    _mirror_legacy_context(root, markdown)


def _read_language_artifact(root: Path) -> str:
    canonical = _read_optional(root / UBIQUITOUS_LANGUAGE_PATH)
    if canonical.strip():
        return canonical
    return _read_optional(root / CONTEXT_PATH)


def _mirror_legacy_context(root: Path, markdown: str) -> None:
    path = root / CONTEXT_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(markdown.rstrip() + "\n", encoding="utf-8")


def _write_requirements_doc(root: Path, session: dict[str, Any]) -> None:
    path = root / REQUIREMENTS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    markdown = _sanitize_requirements_markdown(
        str(session.get("draft_requirements_markdown", "") or "").strip()
    )
    if markdown:
        path.write_text(markdown + "\n", encoding="utf-8")
        return
    gate = "Passed" if session["requirements_gate_passed"] else "Needs Clarification"
    lines = [
        "# 요구사항",
        "",
        f"- Initial idea: {session['initial_prompt']}",
        f"- Current gate: {gate}",
        "",
        "## Grill-Me Clarifications",
        "",
        "| ID | Question | Response |",
        "| --- | --- | --- |",
    ]
    for index, item in enumerate(session["clarifications"], start=1):
        questions = item.get("questions") or []
        question_text = questions[0].get("question", "") if questions else ""
        lines.append(f"| GM-{index:03d} | {question_text} | {item.get('answer', '')} |")
    if _current_question(session) or session.get("pending_questions"):
        lines.extend(["", "## Blocking Open Language Questions", ""])
        queue = []
        current = _current_question(session)
        if current:
            queue.append(current)
        queue.extend(session.get("pending_questions") or [])
        for index, item in enumerate(queue, start=1):
            recommended = item.get("recommended", "")
            suffix = f" Recommended: {recommended}" if recommended else ""
            lines.append(f"- Q{index}: {item.get('question', '')}{suffix}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _sanitize_requirements_markdown(markdown: str) -> str:
    if not markdown:
        return ""
    return markdown.replace("| ID | Question | Answer |", "| ID | Question | Response |")


def _fallback_context_markdown(session: dict[str, Any]) -> str:
    open_questions: list[str] = []
    current = _current_question(session)
    if current and current.get("question"):
        open_questions.append(str(current["question"]))
    for item in session.get("pending_questions") or []:
        question = str(item.get("question", "")).strip()
        if question:
            open_questions.append(question)
    lines = [
        "# Project Context",
        "",
        "## 1. Ubiquitous Language",
        "",
        "| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |",
        "|---|---|---|---|---|---|---|---|",
        "| User | 사용자 | User | Actor | Primary external actor confirmed through harvest. | - | - | grill-me |",
        "",
        "## 2. Naming Rules",
        "",
        "- Documents must use `Canonical Term`.",
        "- Code class, method, package, command, event, and policy identifiers must use `English`.",
        "- User-facing text should use `Korean`.",
        "- `Forbidden Terms` must not be used in new documents, plans, tests, or code identifiers.",
        "- Aliases are recorded only for migration/search context and must not be introduced as new canonical language.",
        "",
        "## 3. Blocking Open Language Questions",
        "",
    ]
    if open_questions:
        lines.extend(f"- {question}" for question in open_questions)
    else:
        lines.append("- None.")
    lines.extend(["", "## 4. Deferred Language Questions", "", "- None."])
    return "\n".join(lines)


def _has_runtime_ready_use_case_slices(root: Path) -> bool:
    ready, _ = _validate_runtime_ready_use_case_slices(root)
    return ready


def _sync_use_case_readiness(root: Path, session: dict[str, Any]) -> None:
    if not session.get("requirements_gate_passed") or not session.get("language_gate_passed"):
        session["use_cases_ready"] = False
        return
    ready, _ = _validate_runtime_ready_use_case_slices(root)
    was_ready = bool(session.get("use_cases_ready"))
    session["use_cases_ready"] = ready
    if ready and isinstance(session.get("ddd_architecture"), dict):
        session["active_stage"] = "dddArchitecture"
    elif ready and isinstance(session.get("event_storming"), dict):
        session["active_stage"] = "eventStorming"
    elif ready:
        session["active_stage"] = "useCases"
    elif was_ready:
        session["active_stage"] = "ubiquitousLanguage"


def _validate_runtime_ready_use_case_slices(root: Path) -> tuple[bool, str]:
    canonical_path = root / USE_CASES_PATH
    if not canonical_path.is_file():
        return False, (
            "docs/design/유스케이스.md is missing, empty, or has no parseable UC entries. "
            "Expected '- UC-001. ...' or '## UC-001. ...'."
        )

    canonical_text = canonical_path.read_text(encoding="utf-8")
    if not canonical_text.strip():
        return False, (
            "docs/design/유스케이스.md is missing, empty, or has no parseable UC entries. "
            "Expected '- UC-001. ...' or '## UC-001. ...'."
        )

    uc_ids = _parse_canonical_use_case_ids(canonical_text)
    if not uc_ids:
        return False, (
            "docs/design/유스케이스.md is missing, empty, or has no parseable UC entries. "
            "Expected '- UC-001. ...' or '## UC-001. ...'."
        )

    missing_files: list[str] = []
    for uc_id in uc_ids:
        use_case_path = root / USE_CASE_SLICE_ROOT / uc_id / "use-case.md"
        e2e_path = root / USE_CASE_SLICE_ROOT / uc_id / "e2e-goal.md"
        if not use_case_path.is_file():
            missing_files.append(str(USE_CASE_SLICE_ROOT / uc_id / "use-case.md"))
        if not e2e_path.is_file():
            missing_files.append(str(USE_CASE_SLICE_ROOT / uc_id / "e2e-goal.md"))
        if missing_files:
            continue
        if _looks_like_placeholder(use_case_path.read_text(encoding="utf-8")):
            missing_files.append(str(USE_CASE_SLICE_ROOT / uc_id / "use-case.md"))
        if _looks_like_placeholder(e2e_path.read_text(encoding="utf-8")):
            missing_files.append(str(USE_CASE_SLICE_ROOT / uc_id / "e2e-goal.md"))
    if missing_files:
        missing_list = ", ".join(sorted(dict.fromkeys(missing_files)))
        return False, f"runtime-ready use-case docs are missing: {missing_list}"
    return True, ""


def _parse_canonical_use_case_ids(text: str) -> list[str]:
    matches = re.findall(r"^(?:- |## )(UC-\d+)\.\s+.+$", text, flags=re.MULTILINE)
    return list(dict.fromkeys(match.strip() for match in matches))


def _looks_like_placeholder(text: str) -> bool:
    placeholder_markers = (
        "TBD from confirmed requirements",
        "See canonical source",
        "To be derived",
    )
    return any(marker in text for marker in placeholder_markers)


def _read_optional(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""
