from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping


ALLOWED_COMPONENTS = ("agent-context", "skills", "runner-policy", "verification")
EVOLUTION_ROOT = Path(".harness/evolution")
INTENT_FEEDBACK_FILE = Path("intent-feedback.jsonl")
INTERACTION_PHASES = (
    "grill_me",
    "follow_up",
    "approval",
    "post_artifact_feedback",
)
MISALIGNMENT_COMPONENTS = {
    "scope": "agent-context",
    "priority": "agent-context",
    "workflow_stage": "runner-policy",
    "domain_rule": "agent-context",
    "output_shape": "skills",
    "terminology": "agent-context",
    "evidence_expectation": "verification",
}


class EvolutionError(RuntimeError):
    pass


@dataclass(frozen=True)
class EvolutionClassification:
    status: str
    reason: str
    component: str


@dataclass(frozen=True)
class EvolutionProposal:
    proposal_id: str
    proposal_path: Path
    experience_dir: Path
    classification: EvolutionClassification
    target_path: Path


@dataclass(frozen=True)
class IntentFeedbackEvent:
    run_id: str
    work_item_id: str
    step_id: str
    interaction_phase: str
    agent_question: str
    agent_recommended_answer: str
    user_answer: str
    agent_assumption: str
    correction: str
    intent_delta: str
    misalignment_kind: str
    reusable_rule: str


def record_intent_feedback(
    repo_root: Path | str,
    event: Mapping[str, Any],
) -> Path:
    root = Path(repo_root)
    normalized = _normalize_intent_feedback(event)
    run_dir = root / ".harness/runs" / normalized.run_id
    if not run_dir.exists():
        raise EvolutionError(f"missing run directory: {_display(run_dir, root)}")

    feedback_path = run_dir / INTENT_FEEDBACK_FILE
    with feedback_path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(normalized.__dict__, ensure_ascii=True) + "\n")
    return _display(feedback_path, root)


def propose_evolution(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
) -> EvolutionProposal:
    root = Path(repo_root)
    _validate_identifier("change_set_id", change_set_id)
    _validate_identifier("work_item_id", work_item_id)
    _validate_identifier("run_id", run_id)
    run_dir = root / ".harness/runs" / run_id
    if not run_dir.exists():
        raise EvolutionError(f"missing run directory: {_display(run_dir, root)}")

    feedback = _collect_intent_feedback(run_dir, work_item_id)
    if not feedback:
        raise EvolutionError(
            "no intent-alignment feedback found for "
            f"work item {work_item_id} in run {run_id}"
        )
    classification = classify_intent_feedback(feedback[-1])
    proposal_id = _next_proposal_id(root)
    experience_dir = (
        EVOLUTION_ROOT
        / "experiences"
        / change_set_id
        / work_item_id
        / run_id
    )
    absolute_experience_dir = root / experience_dir
    absolute_experience_dir.mkdir(parents=True, exist_ok=True)

    target_path = (
        EVOLUTION_ROOT
        / "components"
        / classification.component
        / f"{proposal_id}.md"
    )
    _write_experience_files(
        root,
        absolute_experience_dir,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        run_id=run_id,
        feedback=feedback,
        classification=classification,
    )

    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    absolute_proposal_path = root / proposal_path
    absolute_proposal_path.parent.mkdir(parents=True, exist_ok=True)
    absolute_proposal_path.write_text(
        _proposal_markdown(
            proposal_id=proposal_id,
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            run_id=run_id,
            feedback=feedback,
            classification=classification,
            target_path=target_path,
        ),
        encoding="utf-8",
    )

    return EvolutionProposal(
        proposal_id=proposal_id,
        proposal_path=proposal_path,
        experience_dir=experience_dir,
        classification=classification,
        target_path=target_path,
    )


def classify_intent_feedback(
    event: IntentFeedbackEvent | Mapping[str, Any],
) -> EvolutionClassification:
    normalized = (
        event
        if isinstance(event, IntentFeedbackEvent)
        else _normalize_intent_feedback(event)
    )
    component = MISALIGNMENT_COMPONENTS[normalized.misalignment_kind]
    return EvolutionClassification(
        "eligible",
        (
            "User correction exposed an implementation-intent mismatch "
            f"during {normalized.interaction_phase}."
        ),
        component,
    )


def classify_failure_for_evolution(text: str) -> EvolutionClassification:
    return EvolutionClassification(
        "not_eligible",
        (
            "Verifier, test, contract, implementation, and environment failures "
            "must use existing repair gates, not evolution."
        ),
        "verification",
    )


def accept_evolution(repo_root: Path | str, proposal_id: str) -> tuple[Path, Path]:
    root = Path(repo_root)
    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    absolute_proposal_path = root / proposal_path
    if not absolute_proposal_path.exists():
        raise EvolutionError(f"missing proposal: {proposal_path}")

    text = absolute_proposal_path.read_text(encoding="utf-8")
    target_path = _target_path_from_proposal(text)
    _validate_component_target(target_path)
    if _classification_status_from_proposal(text) != "eligible":
        raise EvolutionError("only eligible intent-feedback proposals can be accepted")

    accepted_path = EVOLUTION_ROOT / "accepted" / f"{proposal_id}.md"
    absolute_accepted_path = root / accepted_path
    absolute_target_path = root / target_path
    absolute_accepted_path.parent.mkdir(parents=True, exist_ok=True)
    absolute_target_path.parent.mkdir(parents=True, exist_ok=True)

    accepted_text = _set_reviewer_decision(text, "accepted")
    absolute_accepted_path.write_text(accepted_text, encoding="utf-8")
    absolute_proposal_path.write_text(accepted_text, encoding="utf-8")
    absolute_target_path.write_text(accepted_text, encoding="utf-8")
    return accepted_path, target_path


def reject_evolution(repo_root: Path | str, proposal_id: str) -> Path:
    root = Path(repo_root)
    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    absolute_proposal_path = root / proposal_path
    if not absolute_proposal_path.exists():
        raise EvolutionError(f"missing proposal: {proposal_path}")
    text = absolute_proposal_path.read_text(encoding="utf-8")
    absolute_proposal_path.write_text(
        _set_reviewer_decision(text, "rejected"),
        encoding="utf-8",
    )
    return proposal_path


def _collect_intent_feedback(
    run_dir: Path,
    work_item_id: str,
) -> tuple[IntentFeedbackEvent, ...]:
    feedback_path = run_dir / INTENT_FEEDBACK_FILE
    if not feedback_path.exists():
        return ()

    events: list[IntentFeedbackEvent] = []
    for line_number, line in enumerate(
        feedback_path.read_text(encoding="utf-8").splitlines(),
        start=1,
    ):
        if not line.strip():
            continue
        try:
            raw_event = json.loads(line)
        except json.JSONDecodeError as error:
            raise EvolutionError(
                f"invalid intent feedback JSON at line {line_number}: {error.msg}"
            ) from error
        event = _normalize_intent_feedback(raw_event)
        if event.work_item_id == work_item_id:
            events.append(event)
    return tuple(events)


def _write_experience_files(
    root: Path,
    experience_dir: Path,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    feedback: Iterable[IntentFeedbackEvent],
    classification: EvolutionClassification,
) -> None:
    feedback_items = tuple(feedback)
    (experience_dir / "trajectory-summary.md").write_text(
        "\n".join(
            [
                f"# Trajectory Summary: {run_id}",
                "",
                f"- ChangeSet: `{change_set_id}`",
                f"- Work item: `{work_item_id}`",
                f"- Run: `{run_id}`",
                "- Status: implementation-intent correction selected for evolution review",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (experience_dir / "intent-feedback.json").write_text(
        json.dumps(
            [item.__dict__ for item in feedback_items],
            indent=2,
            ensure_ascii=True,
        )
        + "\n",
        encoding="utf-8",
    )
    (experience_dir / "intent-analysis.md").write_text(
        "\n".join(
            [
                "# Intent Alignment Analysis",
                "",
                f"- Classification: `{classification.status}`",
                f"- Component: `{classification.component}`",
                f"- Reason: {classification.reason}",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _proposal_markdown(
    *,
    proposal_id: str,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    feedback: Iterable[IntentFeedbackEvent],
    classification: EvolutionClassification,
    target_path: Path,
) -> str:
    feedback_lines = "\n".join(
        (
            f"- Step `{item.step_id}` ({item.interaction_phase}, "
            f"{item.misalignment_kind}): {item.correction} "
            f"Reusable rule: {item.reusable_rule}"
        )
        for item in feedback
    )
    return (
        f"# Evolution Proposal: {proposal_id}\n\n"
        "## Observed Intent Misalignment\n\n"
        f"{classification.reason}\n\n"
        "## Affected Workflow Step\n\n"
        f"- ChangeSet: `{change_set_id}`\n"
        f"- Work item: `{work_item_id}`\n"
        f"- Run: `{run_id}`\n\n"
        "## Intent Feedback\n\n"
        f"{feedback_lines}\n\n"
        "## Proposed Mutable Component Change\n\n"
        f"- Classification: `{classification.status}`\n"
        f"- Component: `{classification.component}`\n"
        f"- Target path: `{target_path}`\n"
        "- Change: Capture the corrected implementation intent as reusable guidance only.\n\n"
        "## Expected Impact\n\n"
        "- Similar future interactions should align with user intent before artifact generation.\n\n"
        "## Validation Method\n\n"
        "- Regenerate the affected artifact with this guidance.\n"
        "- Run the existing artifact verifier and contract gate before downstream handoff.\n"
        "- Repair verifier failures through the existing repair loop; do not feed them back into evolution.\n\n"
        "## Rollback Method\n\n"
        f"- Remove `{target_path}` and the accepted copy for this proposal.\n\n"
        "## Reviewer Decision\n\n"
        "- Reviewer decision: `pending`\n"
    )


def _next_proposal_id(root: Path) -> str:
    today = datetime.now().strftime("%Y%m%d")
    proposal_dir = root / EVOLUTION_ROOT / "proposals"
    existing = sorted(proposal_dir.glob(f"EVO-{today}-*.md"))
    numbers = []
    for path in existing:
        match = re.match(rf"EVO-{today}-(\d{{3}})\.md$", path.name)
        if match:
            numbers.append(int(match.group(1)))
    return f"EVO-{today}-{(max(numbers) if numbers else 0) + 1:03d}"


def _normalize_intent_feedback(event: Mapping[str, Any]) -> IntentFeedbackEvent:
    if not isinstance(event, Mapping):
        raise EvolutionError("intent feedback event must be a JSON object")

    required_fields = (
        "run_id",
        "work_item_id",
        "step_id",
        "interaction_phase",
        "correction",
        "intent_delta",
        "misalignment_kind",
        "reusable_rule",
    )
    values: dict[str, str] = {}
    for field in required_fields:
        value = event.get(field)
        if not isinstance(value, str) or not value.strip():
            raise EvolutionError(f"intent feedback field must be non-empty: {field}")
        values[field] = " ".join(value.split())

    if values["interaction_phase"] not in INTERACTION_PHASES:
        allowed = ", ".join(INTERACTION_PHASES)
        raise EvolutionError(f"interaction_phase must be one of: {allowed}")
    if values["misalignment_kind"] not in MISALIGNMENT_COMPONENTS:
        allowed = ", ".join(MISALIGNMENT_COMPONENTS)
        raise EvolutionError(f"misalignment_kind must be one of: {allowed}")

    optional_fields = (
        "agent_question",
        "agent_recommended_answer",
        "user_answer",
        "agent_assumption",
    )
    for field in optional_fields:
        value = event.get(field, "")
        if not isinstance(value, str):
            raise EvolutionError(f"intent feedback field must be text: {field}")
        values[field] = " ".join(value.split())
    _validate_identifier("run_id", values["run_id"])
    _validate_identifier("work_item_id", values["work_item_id"])
    return IntentFeedbackEvent(**values)


def _validate_identifier(name: str, value: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise EvolutionError(f"{name} must be a path-safe identifier")


def _target_path_from_proposal(text: str) -> Path:
    match = re.search(r"Target path:\s*`([^`]+)`", text)
    if not match:
        raise EvolutionError("proposal missing target path")
    return Path(match.group(1))


def _classification_status_from_proposal(text: str) -> str:
    match = re.search(r"Classification:\s*`([^`]+)`", text)
    if not match:
        raise EvolutionError("proposal missing classification")
    return match.group(1)


def _validate_component_target(path: Path) -> None:
    parts = path.parts
    expected_prefix = (".harness", "evolution", "components")
    if len(parts) < 5 or parts[:3] != expected_prefix:
        raise EvolutionError("target path must be under .harness/evolution/components/")
    if parts[3] not in ALLOWED_COMPONENTS:
        allowed = ", ".join(ALLOWED_COMPONENTS)
        raise EvolutionError(f"target component must be one of: {allowed}")
    if path.suffix != ".md":
        raise EvolutionError("target guidance must be a markdown file")
    if any(part in ("..", "") for part in parts):
        raise EvolutionError("target path must not contain parent traversal")


def _set_reviewer_decision(text: str, decision: str) -> str:
    replacement = f"- Reviewer decision: `{decision}`"
    updated, count = re.subn(
        r"- Reviewer decision:\s*`[^`]+`",
        replacement,
        text,
        count=1,
    )
    if count:
        return updated
    return text.rstrip() + f"\n\n## Reviewer Decision\n\n{replacement}\n"


def _display(path: Path, root: Path) -> Path:
    try:
        return path.relative_to(root)
    except ValueError:
        return path
