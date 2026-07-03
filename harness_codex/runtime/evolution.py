from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from harness_codex.runtime.changeset_memory import (
    ChangeSetMemoryError,
    create_verified_memory_document,
    current_repository_revision,
)
from harness_codex.runtime.episode import read_run_episodes

ALLOWED_COMPONENTS = ("agent-context", "skills", "runner-policy", "verification")
EVOLUTION_ROOT = Path(".harness/evolution")
INTENT_FEEDBACK_FILE = Path("intent-feedback.jsonl")
INTERACTION_PHASES = ("grill_me", "follow_up", "approval", "post_artifact_feedback")
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
    """Raised when an evolution artifact violates governance rules."""


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
class EvolutionImprovement:
    """Analysis result.

    `improve` deliberately creates no promoted runtime asset. The two paths are
    review artifacts: a recorded evaluation plan and an explicit deferred
    promotion state.
    """

    proposal: EvolutionProposal
    replay_path: Path
    promotion_state_path: Path
    canary_scope: str


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


@dataclass(frozen=True)
class EvolutionMemorySync:
    status: str
    reason: str
    memory_path: Path | None = None


def record_intent_feedback(repo_root: Path | str, event: Mapping[str, Any]) -> Path:
    root = Path(repo_root)
    normalized = _normalize_intent_feedback(event)
    run_dir = root / ".harness/runs" / normalized.run_id
    if not run_dir.exists():
        raise EvolutionError(f"missing run directory: {_display(run_dir, root)}")
    path = run_dir / INTENT_FEEDBACK_FILE
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(normalized.__dict__, ensure_ascii=True) + "\n")
    return _display(path, root)


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
    experience_dir = EVOLUTION_ROOT / "experiences" / change_set_id / work_item_id / run_id
    absolute_experience_dir = root / experience_dir
    absolute_experience_dir.mkdir(parents=True, exist_ok=True)
    target_path = _target_path(classification.component, proposal_id)

    _write_intent_experience_files(
        absolute_experience_dir,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        run_id=run_id,
        feedback=feedback,
        classification=classification,
    )
    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    (root / proposal_path).parent.mkdir(parents=True, exist_ok=True)
    (root / proposal_path).write_text(
        _intent_proposal_markdown(
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
    normalized = event if isinstance(event, IntentFeedbackEvent) else _normalize_intent_feedback(event)
    return EvolutionClassification(
        status="eligible",
        reason=(
            "User correction exposed an implementation-intent mismatch "
            f"during {normalized.interaction_phase}."
        ),
        component=MISALIGNMENT_COMPONENTS[normalized.misalignment_kind],
    )


def classify_failure_for_evolution(_text: str) -> EvolutionClassification:
    return EvolutionClassification(
        status="not_eligible",
        reason=(
            "Verifier, test, contract, implementation, and environment failures "
            "must use existing repair gates, not evolution."
        ),
        component="verification",
    )


def evolution_metrics(
    repo_root: Path | str,
    *,
    run_id: str | None = None,
    change_set_id: str | None = None,
) -> dict[str, Any]:
    episodes = _filtered_episodes(Path(repo_root), run_id=run_id, change_set_id=change_set_id)
    if not episodes:
        raise EvolutionError("matching run episodes not found")

    failure_classes = Counter(
        str(item.get("failure_class"))
        for item in episodes
        if item.get("failure_class")
    )
    quality_failures = Counter(
        str(item.get("failure_class"))
        for item in episodes
        if item.get("failure_class") and item.get("failure_class") != "environment_blocker"
    )
    durations = [
        float(stage.get("duration_ms", 0))
        for item in episodes
        for stage in item.get("stages", [])
        if isinstance(stage, Mapping) and isinstance(stage.get("duration_ms"), (int, float))
    ]
    total = len(episodes)
    return {
        "episode_count": total,
        "first_run_pass_rate": round(
            sum(item.get("final_status") == "succeeded" for item in episodes) / total,
            4,
        ),
        "failure_classes": dict(sorted(failure_classes.items())),
        "quality_failure_classes": dict(sorted(quality_failures.items())),
        "environment_blocker_count": failure_classes.get("environment_blocker", 0),
        "duration_ms": {
            "average": round(sum(durations) / len(durations), 3) if durations else 0,
            "p50": _percentile(durations, 0.50),
            "p95": _percentile(durations, 0.95),
        },
    }


def propose_evolution_from_episodes(
    repo_root: Path | str,
    *,
    change_set_id: str | None = None,
    work_item_id: str | None = None,
    min_count: int = 2,
) -> EvolutionProposal:
    root = Path(repo_root)
    if change_set_id:
        _validate_identifier("change_set_id", change_set_id)
    if work_item_id:
        _validate_identifier("work_item_id", work_item_id)

    episodes = _filtered_episodes(root, change_set_id=change_set_id, work_item_id=work_item_id)
    candidates = [
        episode
        for episode in episodes
        if episode.get("failure_class")
        and episode.get("failure_class") != "environment_blocker"
        and episode.get("failure_fingerprint")
    ]
    if not candidates:
        raise EvolutionError("no eligible non-environment failure episodes found")

    grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for episode in candidates:
        grouped[str(episode["failure_fingerprint"])].append(episode)
    fingerprint, matches = max(grouped.items(), key=lambda item: (len(item[1]), item[0]))
    if len(matches) < max(min_count, 1):
        raise EvolutionError(f"no repeated failure pattern reached min-count={min_count}")

    selected_change_set_id = change_set_id or str(matches[0].get("changeset_id") or "unknown-changeset")
    selected_work_item_id = work_item_id or _first_work_item_id(matches[0])
    if not selected_work_item_id:
        raise EvolutionError("matching episode has no work item id")

    classification = EvolutionClassification(
        status="eligible",
        reason="Repeated non-environment run episode failure pattern qualifies for evolution review.",
        component=_component_for_failure(str(matches[0].get("failure_class") or "")),
    )
    proposal_id = _next_proposal_id(root)
    first_run_id = str(matches[0].get("run_id") or "unknown-run")
    experience_dir = (
        EVOLUTION_ROOT
        / "experiences"
        / selected_change_set_id
        / selected_work_item_id
        / first_run_id
    )
    absolute_experience_dir = root / experience_dir
    absolute_experience_dir.mkdir(parents=True, exist_ok=True)
    target_path = _target_path(classification.component, proposal_id)
    _write_episode_experience_files(
        absolute_experience_dir,
        change_set_id=selected_change_set_id,
        work_item_id=selected_work_item_id,
        fingerprint=fingerprint,
        episodes=matches,
        classification=classification,
    )

    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    (root / proposal_path).parent.mkdir(parents=True, exist_ok=True)
    (root / proposal_path).write_text(
        _episode_proposal_markdown(
            proposal_id=proposal_id,
            change_set_id=selected_change_set_id,
            work_item_id=selected_work_item_id,
            episodes=matches,
            fingerprint=fingerprint,
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


def improve_evolution(
    repo_root: Path | str,
    *,
    change_set_id: str | None = None,
    work_item_id: str | None = None,
    min_count: int = 2,
    canary_scope: str | None = None,
) -> EvolutionImprovement:
    """Analyze repeated failures and prepare review artifacts only.

    This intentionally does not invoke replay, accept, promote, or mutate the
    active runtime. Automated promotion is forbidden until an isolated evaluator
    produces real candidate evidence.
    """

    root = Path(repo_root)
    proposal = propose_evolution_from_episodes(
        root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        min_count=min_count,
    )
    evaluation_path = _write_evaluation_plan(root, proposal)
    scope = canary_scope.strip() if isinstance(canary_scope, str) and canary_scope.strip() else "manual-approval-required"
    deferred_path = _write_promotion_state(
        root,
        {
            "proposal_id": proposal.proposal_id,
            "status": "pending_evaluation",
            "reason": "automatic promotion disabled; approve only after isolated candidate evaluation",
            "canary_scope": scope,
            "recorded_at": datetime.now().isoformat(timespec="seconds"),
        },
    )
    return EvolutionImprovement(
        proposal=proposal,
        replay_path=evaluation_path,
        promotion_state_path=deferred_path,
        canary_scope=scope,
    )


def replay_evolution(repo_root: Path | str, proposal_id: str) -> Path:
    """Record an evaluator requirement, never a synthetic pass result.

    Historical episode metadata proves that a problem existed. It does not prove
    that a candidate skill or policy fixes it, so this command blocks promotion
    until a future isolated evaluator supplies observed candidate results.
    """

    root = Path(repo_root)
    _validate_identifier("proposal_id", proposal_id)
    text = _read_proposal(root, EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md")
    output = EVOLUTION_ROOT / "evaluations" / proposal_id / "replay-result.json"
    absolute = root / output
    absolute.parent.mkdir(parents=True, exist_ok=True)
    run_ids = re.findall(r"Run ID: `([^`]+)`", text)
    absolute.write_text(
        json.dumps(
            {
                "proposal_id": proposal_id,
                "status": "blocked",
                "reason": "candidate_execution_not_implemented",
                "evaluated_run_ids": run_ids,
                "required_evidence": [
                    "isolated candidate materialization",
                    "deterministic evaluator command results",
                    "baseline-versus-candidate comparison",
                    "reviewer approval",
                ],
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return output


def promote_evolution(repo_root: Path | str, proposal_id: str, *, canary_scope: str) -> Path:
    root = Path(repo_root)
    _validate_identifier("proposal_id", proposal_id)
    if not canary_scope.strip():
        raise EvolutionError("canary scope must be non-empty")

    replay = _read_json(root / EVOLUTION_ROOT / "evaluations" / proposal_id / "replay-result.json")
    if replay.get("status") != "passed":
        raise EvolutionError("replay must pass with isolated candidate evidence before promotion")

    accepted_path, target_path = accept_evolution(root, proposal_id)
    return _write_promotion_state(
        root,
        {
            "proposal_id": proposal_id,
            "status": "canary",
            "canary_scope": canary_scope,
            "accepted_path": str(accepted_path),
            "target_path": str(target_path),
            "promoted_at": datetime.now().isoformat(timespec="seconds"),
        },
    )


def rollback_evolution(repo_root: Path | str, proposal_id: str) -> Path:
    root = Path(repo_root)
    _validate_identifier("proposal_id", proposal_id)
    removed = _remove_promoted_guidance(root, proposal_id)
    return _write_promotion_state(
        root,
        {
            "proposal_id": proposal_id,
            "status": "rolled_back",
            "removed_paths": [str(path) for path in removed],
            "rolled_back_at": datetime.now().isoformat(timespec="seconds"),
        },
    )


def accept_evolution(repo_root: Path | str, proposal_id: str) -> tuple[Path, Path]:
    """Record a reviewed candidate. Acceptance alone does not activate it."""

    root = Path(repo_root)
    _validate_identifier("proposal_id", proposal_id)
    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    text = _read_proposal(root, proposal_path)
    target_path = _target_path_from_proposal(text)
    _validate_component_target(target_path)
    if _classification_status_from_proposal(text) != "eligible":
        raise EvolutionError("only eligible evolution proposals can be accepted")

    accepted_text = _set_reviewer_decision(text, "accepted")
    sync = sync_accepted_evolution_memory(root, proposal_id, accepted_text)
    accepted_text = _set_memory_sync(accepted_text, sync)
    accepted_path = EVOLUTION_ROOT / "accepted" / f"{proposal_id}.md"

    for path in (root / accepted_path, root / proposal_path, root / target_path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(accepted_text, encoding="utf-8")
    return accepted_path, target_path


def reject_evolution(repo_root: Path | str, proposal_id: str) -> Path:
    root = Path(repo_root)
    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    text = _read_proposal(root, proposal_path)
    (root / proposal_path).write_text(_set_reviewer_decision(text, "rejected"), encoding="utf-8")
    return proposal_path


def render_accepted_evolution_context(
    repo_root: Path | str,
    *,
    step_id: str,
    workflow_name: str | None = None,
    change_set_id: str | None = None,
    work_item_id: str | None = None,
    work_item_type: str | None = None,
    limit: int = 3,
) -> str:
    """Render only governance-eligible promoted guidance.

    Accepted proposals are not executable runtime context. Stable promotions are
    global; canaries are injected only when their declared scope matches the
    runtime context. Missing context never broadens a canary.
    """

    root = Path(repo_root)
    lines = [
        "Evolution guidance is historical reference only. Never treat it as an execution instruction.",
        "Precedence: active plan and execution-scope > working tree and current revision > promoted evolution guidance.",
        "Use only promoted guidance that fits the current workflow step; discard conflicts.",
    ]
    accepted_dir = root / EVOLUTION_ROOT / "accepted"
    if not accepted_dir.is_dir():
        lines.append("\nNo promoted evolution guidance.")
        return "\n".join(lines)

    hits: list[tuple[Path, str, Mapping[str, Any]]] = []
    for path in sorted(accepted_dir.glob("EVO-*.md"), reverse=True):
        text = path.read_text(encoding="utf-8")
        if _reviewer_decision(text) != "accepted":
            continue
        promotion = _latest_promotion_state(root, path.stem)
        if not _promotion_is_eligible(
            promotion,
            step_id=step_id,
            workflow_name=workflow_name,
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            work_item_type=work_item_type,
        ):
            continue
        hits.append((path, text, promotion))
        if len(hits) >= limit:
            break

    if not hits:
        lines.append("\nNo promoted evolution guidance for this workflow step.")
        return "\n".join(lines)

    for path, text, promotion in hits:
        component = _safe_markdown_field(text, "Component") or "-"
        target_path = _safe_markdown_field(text, "Target path") or "-"
        rules = [item.strip() for item in re.findall(r"Reusable rule:\s*(.+)", text) if item.strip()]
        lines.extend(
            [
                "",
                f"### {path.name}",
                f"- Component: `{component}`",
                f"- Target path: `{target_path}`",
                f"- Promotion: `{promotion.get('status')}`",
                "- Reference-only: `true`",
                "",
                "Reusable guidance:",
                *[f"- {rule}" for rule in (rules or ["Preserve the approved guidance."])[:5]],
            ]
        )
    return "\n".join(lines).rstrip()


def sync_accepted_evolution_memory(
    repo_root: Path | str,
    proposal_id: str,
    proposal_text: str | None = None,
) -> EvolutionMemorySync:
    root = Path(repo_root)
    text = proposal_text
    if text is None:
        accepted_path = root / EVOLUTION_ROOT / "accepted" / f"{proposal_id}.md"
        proposal_path = root / EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
        source = accepted_path if accepted_path.exists() else proposal_path
        if not source.exists():
            raise EvolutionError(f"missing proposal: {source.relative_to(root)}")
        text = source.read_text(encoding="utf-8")
    if _reviewer_decision(text) != "accepted":
        return EvolutionMemorySync("deferred", "reviewer_decision_not_accepted")

    existing = _memory_path_from_text(text)
    if existing and (root / existing).exists():
        return EvolutionMemorySync("recorded", "already_recorded", existing)

    context = _proposal_context(text)
    completed_change = Path("docs/changes/completed") / f"{context['change_set_id']}.md"
    completed_plan = Path("docs/plans/completed") / context["work_item_id"] / "plan.md"
    if not (root / completed_change).exists():
        return EvolutionMemorySync("deferred", "changeset_not_completed")
    if not (root / completed_plan).exists():
        return EvolutionMemorySync("deferred", "work_item_plan_not_completed")
    revision = current_repository_revision(root)
    if revision is None:
        return EvolutionMemorySync("deferred", "repository_revision_unavailable")

    try:
        path = create_verified_memory_document(
            root,
            memory_id=_next_memory_id(root),
            kind="review_learning",
            source_path=completed_change,
            change_set_id=context["change_set_id"],
            work_item_id=context["work_item_id"],
            repository_revision=revision,
            tags=("evolution", "intent-alignment", context["component"]),
            applies_to=_memory_stages(text),
            body=_memory_body(proposal_id, context, text),
        )
    except ChangeSetMemoryError as error:
        return EvolutionMemorySync("deferred", f"memory_write_blocked:{error}")
    return EvolutionMemorySync("recorded", "accepted_evolution_verified", _display(path, root))


def _filtered_episodes(
    root: Path,
    *,
    run_id: str | None = None,
    change_set_id: str | None = None,
    work_item_id: str | None = None,
) -> tuple[Mapping[str, Any], ...]:
    selected = []
    for episode in read_run_episodes(root):
        if run_id and episode.get("run_id") != run_id:
            continue
        if change_set_id and episode.get("changeset_id") != change_set_id:
            continue
        work_items = [str(value) for value in episode.get("work_item_ids", [])]
        if work_item_id and work_item_id not in work_items:
            continue
        selected.append(episode)
    return tuple(selected)


def _collect_intent_feedback(run_dir: Path, work_item_id: str) -> tuple[IntentFeedbackEvent, ...]:
    path = run_dir / INTENT_FEEDBACK_FILE
    if not path.exists():
        return ()
    result = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as error:
            raise EvolutionError(f"invalid intent feedback JSON at line {line_number}: {error.msg}") from error
        event = _normalize_intent_feedback(raw)
        if event.work_item_id == work_item_id:
            result.append(event)
    return tuple(result)


def _write_intent_experience_files(
    experience_dir: Path,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    feedback: Iterable[IntentFeedbackEvent],
    classification: EvolutionClassification,
) -> None:
    events = tuple(feedback)
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
        ) + "\n",
        encoding="utf-8",
    )
    (experience_dir / "intent-feedback.json").write_text(
        json.dumps([item.__dict__ for item in events], ensure_ascii=True, indent=2) + "\n",
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
        ) + "\n",
        encoding="utf-8",
    )


def _write_episode_experience_files(
    experience_dir: Path,
    *,
    change_set_id: str,
    work_item_id: str,
    fingerprint: str,
    episodes: Iterable[Mapping[str, Any]],
    classification: EvolutionClassification,
) -> None:
    items = tuple(episodes)
    (experience_dir / "trajectory-summary.md").write_text(
        "\n".join(
            [
                f"# Episode Pattern Summary: {fingerprint}",
                "",
                f"- ChangeSet: `{change_set_id}`",
                f"- Work item: `{work_item_id}`",
                f"- Pattern count: `{len(items)}`",
                "- Status: repeated run episode failure selected for evolution review",
                "",
                "## Runs",
                "",
                *[
                    f"- `{item.get('run_id')}`: `{item.get('failure_class')}`"
                    for item in items
                ],
            ]
        ) + "\n",
        encoding="utf-8",
    )
    (experience_dir / "episodes.json").write_text(
        json.dumps(items, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (experience_dir / "episode-analysis.md").write_text(
        "\n".join(
            [
                "# Episode Pattern Analysis",
                "",
                f"- Classification: `{classification.status}`",
                f"- Component: `{classification.component}`",
                f"- Reason: {classification.reason}",
                f"- Failure fingerprint: `{fingerprint}`",
            ]
        ) + "\n",
        encoding="utf-8",
    )


def _intent_proposal_markdown(
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
        f"- Step `{item.step_id}` ({item.interaction_phase}, {item.misalignment_kind}): "
        f"{item.correction} Reusable rule: {item.reusable_rule}"
        for item in feedback
    )
    return _proposal_document(
        proposal_id=proposal_id,
        heading="Observed Intent Misalignment",
        description=classification.reason,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        run_id=run_id,
        source="intent_feedback",
        evidence=feedback_lines,
        classification=classification,
        target_path=target_path,
        reusable_rule="Capture the corrected implementation intent as reviewable guidance only.",
    )


def _episode_proposal_markdown(
    *,
    proposal_id: str,
    change_set_id: str,
    work_item_id: str,
    episodes: Iterable[Mapping[str, Any]],
    fingerprint: str,
    classification: EvolutionClassification,
    target_path: Path,
) -> str:
    items = tuple(episodes)
    failed_gates = _dominant_values(items, "failed_gates")
    failed_commands = _dominant_failed_commands(items)
    unmet = _dominant_values(items, "unmet_obligations")
    stage = _dominant_failed_stage(items)
    rule = _episode_reusable_rule(
        failure_class=str(items[0].get("failure_class") or ""),
        repeated_stage=stage,
        failed_gates=failed_gates,
        failed_commands=failed_commands,
        unmet_obligations=unmet,
    )
    evidence = [
        f"- Failure fingerprint: `{fingerprint}`",
        f"- Pattern count: `{len(items)}`",
    ]
    if stage:
        evidence.append(f"- Repeated failed stage: `{stage}`")
    if failed_gates:
        evidence.append(f"- Failed gates: `{', '.join(failed_gates)}`")
    if failed_commands:
        evidence.append(f"- Failed commands: `{', '.join(failed_commands)}`")
    if unmet:
        evidence.append(f"- Unmet obligations: `{', '.join(unmet)}`")
    run_lines = "\n".join(
        f"- Run ID: `{item.get('run_id')}` failure_class=`{item.get('failure_class')}`"
        for item in items
    )
    return _proposal_document(
        proposal_id=proposal_id,
        heading="Observed Run Episode Pattern",
        description=classification.reason,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        run_id=str(items[0].get("run_id") or "unknown-run"),
        source="run_episode_pattern",
        evidence="\n".join([*evidence, run_lines]),
        classification=classification,
        target_path=target_path,
        reusable_rule=rule,
    )


def _proposal_document(
    *,
    proposal_id: str,
    heading: str,
    description: str,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    source: str,
    evidence: str,
    classification: EvolutionClassification,
    target_path: Path,
    reusable_rule: str,
) -> str:
    return f"""# Evolution Proposal: {proposal_id}

## {heading}

{description}

## Affected Workflow Step

- ChangeSet: `{change_set_id}`
- Work item: `{work_item_id}`
- Run: `{run_id}`
- Source: `{source}`

## Evidence

{evidence}

## Proposed Mutable Component Change

- Classification: `{classification.status}`
- Component: `{classification.component}`
- Target path: `{target_path}`
- Change: Add reviewable workflow or instruction guidance for the observed pattern.
- Reusable rule: {reusable_rule}

## Evaluation Contract

- Candidate evaluation state: `pending`
- Isolated materialization: required
- Baseline and candidate comparison: required
- Deterministic evaluator command evidence: required
- Reviewer approval before canary: required

## Rollback Method

- Run `harness evolution rollback {proposal_id}` after a promoted candidate regresses.

## Reviewer Decision

- Reviewer decision: `pending`

## Long-Term Memory Sync

- Status: `pending_review`
- Memory record: `-`
"""


def _write_evaluation_plan(root: Path, proposal: EvolutionProposal) -> Path:
    path = EVOLUTION_ROOT / "evaluations" / proposal.proposal_id / "evaluation-plan.json"
    absolute = root / path
    absolute.parent.mkdir(parents=True, exist_ok=True)
    absolute.write_text(
        json.dumps(
            {
                "proposal_id": proposal.proposal_id,
                "status": "pending",
                "mode": "isolated_replay_or_shadow",
                "requirements": [
                    "materialize candidate outside the active ChangeSet",
                    "run deterministic evaluator commands",
                    "compare baseline and candidate metrics",
                    "attach reviewer approval before canary",
                ],
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ) + "\n",
        encoding="utf-8",
    )
    return path


def _dominant_failed_stage(episodes: Iterable[Mapping[str, Any]]) -> str:
    values = []
    for episode in episodes:
        for stage in episode.get("stages", []):
            if not isinstance(stage, Mapping):
                continue
            if stage.get("result") in {"failed", "blocked"} or stage.get("failure_kind"):
                name = stage.get("name")
                if isinstance(name, str) and name:
                    values.append(name)
    return Counter(values).most_common(1)[0][0] if values else ""


def _dominant_values(episodes: Iterable[Mapping[str, Any]], key: str) -> tuple[str, ...]:
    values: list[str] = []
    for episode in episodes:
        reports = episode.get("verification", {}).get("reports", [])
        if not isinstance(reports, list):
            continue
        for report in reports:
            if isinstance(report, Mapping) and isinstance(report.get(key), list):
                values.extend(str(value) for value in report[key] if str(value).strip())
    return tuple(value for value, _ in Counter(values).most_common(5))


def _dominant_failed_commands(episodes: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    values: list[str] = []
    for episode in episodes:
        reports = episode.get("verification", {}).get("reports", [])
        if not isinstance(reports, list):
            continue
        for report in reports:
            if not isinstance(report, Mapping):
                continue
            for item in report.get("failed_commands", []):
                if isinstance(item, Mapping) and item.get("command"):
                    values.append(str(item["command"]))
    return tuple(value for value, _ in Counter(values).most_common(5))


def _episode_reusable_rule(
    *,
    failure_class: str,
    repeated_stage: str,
    failed_gates: tuple[str, ...],
    failed_commands: tuple[str, ...],
    unmet_obligations: tuple[str, ...],
) -> str:
    if failed_gates:
        return (
            "Before marking execution complete, run or record evidence for gate(s) "
            f"{', '.join(failed_gates)} and repair failures before handoff."
        )
    if failed_commands:
        return (
            "Before handoff, run the previously failing command(s) "
            f"{', '.join(failed_commands)} first and keep their evidence paths in the verification report."
        )
    if unmet_obligations:
        return (
            "Before completion, satisfy and record the unmet verification obligation(s): "
            f"{', '.join(unmet_obligations)}."
        )
    if repeated_stage == "materialize-execution-scope":
        return "Before materializing execution scope, ensure executable unchecked tasks remain inside the work-item boundary."
    if repeated_stage:
        return f"Before leaving `{repeated_stage}`, verify its required artifact contract and repair the repeated failure pattern."
    if failure_class == "scope_conflict":
        return "Resolve ChangeSet/work-item scope conflict before implementation handoff."
    return "Prevent the repeated failure pattern before execution reaches verification."


def _component_for_failure(failure_class: str) -> str:
    return "verification" if failure_class in {"verification_goal_unclear", "scope_conflict"} else "runner-policy"


def _first_work_item_id(episode: Mapping[str, Any]) -> str:
    values = episode.get("work_item_ids", [])
    return str(values[0]) if isinstance(values, list) and values else ""


def _target_path(component: str, proposal_id: str) -> Path:
    return EVOLUTION_ROOT / "components" / component / f"{proposal_id}.md"


def _latest_promotion_state(root: Path, proposal_id: str) -> Mapping[str, Any]:
    payload = _read_json(root / EVOLUTION_ROOT / "promotion-state.json")
    history = payload.get("history", [])
    if not isinstance(history, list):
        return {}
    for item in reversed(history):
        if isinstance(item, Mapping) and item.get("proposal_id") == proposal_id:
            return item
    return {}


def _promotion_is_eligible(
    promotion: Mapping[str, Any],
    *,
    step_id: str,
    workflow_name: str | None,
    change_set_id: str | None,
    work_item_id: str | None,
    work_item_type: str | None,
) -> bool:
    status = promotion.get("status")
    if status == "stable":
        return True
    if status != "canary":
        return False
    scope = promotion.get("canary_scope")
    if not isinstance(scope, str):
        return False
    return _scope_matches(
        scope,
        step_id=step_id,
        workflow_name=workflow_name,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        work_item_type=work_item_type,
    )


def _scope_matches(
    scope: str,
    *,
    step_id: str,
    workflow_name: str | None,
    change_set_id: str | None,
    work_item_id: str | None,
    work_item_type: str | None,
) -> bool:
    key, separator, value = scope.partition(":")
    if not separator or not value:
        return False
    actual = {
        "step": step_id,
        "workflow": workflow_name,
        "change-set": change_set_id,
        "work-item": work_item_id,
        "work-item-type": work_item_type,
    }.get(key)
    return actual == value


def _write_promotion_state(root: Path, entry: Mapping[str, Any]) -> Path:
    path = root / EVOLUTION_ROOT / "promotion-state.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    state = _read_json(path)
    history = state.get("history", [])
    if not isinstance(history, list):
        history = []
    history.append(dict(entry))
    path.write_text(
        json.dumps({"current": dict(entry), "history": history}, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return _display(path, root)


def _remove_promoted_guidance(root: Path, proposal_id: str) -> tuple[Path, ...]:
    text = _read_proposal(root, EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md")
    paths = (
        EVOLUTION_ROOT / "accepted" / f"{proposal_id}.md",
        _target_path_from_proposal(text),
    )
    removed: list[Path] = []
    for path in paths:
        absolute = root / path
        if absolute.exists():
            try:
                absolute.unlink()
            except OSError as error:
                raise EvolutionError(f"failed to remove promoted guidance: {path}") from error
            removed.append(path)
    proposal_path = root / EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    proposal_path.write_text(_set_reviewer_decision(text, "rolled_back"), encoding="utf-8")
    return tuple(removed)


def _proposal_context(text: str) -> dict[str, str]:
    return {
        "change_set_id": _markdown_field(text, "ChangeSet"),
        "work_item_id": _markdown_field(text, "Work item"),
        "run_id": _markdown_field(text, "Run"),
        "component": _markdown_field(text, "Component"),
    }


def _markdown_field(text: str, label: str) -> str:
    value = _safe_markdown_field(text, label)
    if not value:
        raise EvolutionError(f"proposal missing {label}")
    return value


def _safe_markdown_field(text: str, label: str) -> str | None:
    match = re.search(rf"- {re.escape(label)}:\s*`([^`]+)`", text)
    return match.group(1) if match else None


def _classification_status_from_proposal(text: str) -> str:
    value = _safe_markdown_field(text, "Classification")
    if not value:
        raise EvolutionError("proposal missing classification")
    return value


def _reviewer_decision(text: str) -> str:
    match = re.search(r"Reviewer decision:\s*`([^`]+)`", text)
    return match.group(1) if match else "pending"


def _memory_path_from_text(text: str) -> Path | None:
    match = re.search(r"Memory record:\s*`([^`]+)`", text)
    return Path(match.group(1)) if match and match.group(1) != "-" else None


def _set_memory_sync(text: str, sync: EvolutionMemorySync) -> str:
    path = str(sync.memory_path) if sync.memory_path is not None else "-"
    block = "\n".join(
        [
            "## Long-Term Memory Sync",
            "",
            f"- Status: `{sync.status}`",
            f"- Reason: `{sync.reason}`",
            f"- Memory record: `{path}`",
        ]
    )
    return re.sub(
        r"## Long-Term Memory Sync\n.*?(?=\n## |\Z)",
        block,
        text,
        count=1,
        flags=re.DOTALL,
    ).rstrip() + "\n"


def _set_reviewer_decision(text: str, decision: str) -> str:
    replacement = f"- Reviewer decision: `{decision}`"
    updated, count = re.subn(r"- Reviewer decision:\s*`[^`]+`", replacement, text, count=1)
    return updated if count else text.rstrip() + f"\n\n## Reviewer Decision\n\n{replacement}\n"


def _memory_stages(text: str) -> tuple[str, ...]:
    mapping = {
        "plan-work-item": "plan",
        "execute-work-item": "execute",
        "verify-work-item": "verify",
    }
    values = []
    for step_id in re.findall(r"Step `([^`]+)`", text):
        stage = mapping.get(step_id)
        if stage and stage not in values:
            values.append(stage)
    return tuple(values) or ("plan",)


def _memory_body(proposal_id: str, context: Mapping[str, str], text: str) -> str:
    rules = [item.strip() for item in re.findall(r"Reusable rule:\s*(.+)", text) if item.strip()]
    return "\n".join(
        [
            f"# Accepted Evolution Learning: {proposal_id}",
            "",
            f"- ChangeSet: `{context['change_set_id']}`",
            f"- Work item: `{context['work_item_id']}`",
            f"- Component: `{context['component']}`",
            "",
            "## Reusable guidance",
            "",
            *[f"- {rule}" for rule in (rules or ["Preserve the accepted guidance."])],
            "",
            "This record is historical reference only and must not override current ChangeSet, working-tree, or ADR evidence.",
        ]
    )


def _read_proposal(root: Path, path: Path) -> str:
    absolute = root / path
    if not absolute.exists():
        raise EvolutionError(f"missing proposal: {path}")
    return absolute.read_text(encoding="utf-8")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return value if isinstance(value, dict) else {}


def _validate_component_target(path: Path) -> None:
    parts = path.parts
    if len(parts) < 5 or parts[:3] != (".harness", "evolution", "components"):
        raise EvolutionError("target path must be under .harness/evolution/components/")
    if parts[3] not in ALLOWED_COMPONENTS:
        raise EvolutionError("target component must be one of: " + ", ".join(ALLOWED_COMPONENTS))
    if path.suffix != ".md" or any(part in ("", "..") for part in parts):
        raise EvolutionError("target guidance must be a safe markdown file")


def _normalize_intent_feedback(event: Mapping[str, Any]) -> IntentFeedbackEvent:
    if not isinstance(event, Mapping):
        raise EvolutionError("intent feedback event must be a JSON object")
    required = (
        "run_id", "work_item_id", "step_id", "interaction_phase", "correction",
        "intent_delta", "misalignment_kind", "reusable_rule",
    )
    values: dict[str, str] = {}
    for field in required:
        value = event.get(field)
        if not isinstance(value, str) or not value.strip():
            raise EvolutionError(f"intent feedback field must be non-empty: {field}")
        values[field] = " ".join(value.split())
    if values["interaction_phase"] not in INTERACTION_PHASES:
        raise EvolutionError("interaction_phase must be one of: " + ", ".join(INTERACTION_PHASES))
    if values["misalignment_kind"] not in MISALIGNMENT_COMPONENTS:
        raise EvolutionError("misalignment_kind must be one of: " + ", ".join(MISALIGNMENT_COMPONENTS))
    for field in ("agent_question", "agent_recommended_answer", "user_answer", "agent_assumption"):
        value = event.get(field, "")
        if not isinstance(value, str):
            raise EvolutionError(f"intent feedback field must be text: {field}")
        values[field] = " ".join(value.split())
    _validate_identifier("run_id", values["run_id"])
    _validate_identifier("work_item_id", values["work_item_id"])
    return IntentFeedbackEvent(**values)


def _next_proposal_id(root: Path) -> str:
    today = datetime.now().strftime("%Y%m%d")
    directory = root / EVOLUTION_ROOT / "proposals"
    values = []
    for path in directory.glob(f"EVO-{today}-*.md"):
        match = re.fullmatch(rf"EVO-{today}-(\d{{3}})\.md", path.name)
        if match:
            values.append(int(match.group(1)))
    return f"EVO-{today}-{(max(values) if values else 0) + 1:03d}"


def _next_memory_id(root: Path) -> str:
    today = datetime.now().strftime("%Y%m%d")
    values = []
    for path in (root / "docs/memory").rglob(f"MEM-{today}-*.md"):
        match = re.fullmatch(rf"MEM-{today}-(\d{{3}})\.md", path.name)
        if match:
            values.append(int(match.group(1)))
    return f"MEM-{today}-{(max(values) if values else 0) + 1:03d}"


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    rank = (len(ordered) - 1) * percentile
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (rank - lower), 3)


def _validate_identifier(name: str, value: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise EvolutionError(f"{name} must be a path-safe identifier")


def _display(path: Path, root: Path) -> Path:
    try:
        return path.relative_to(root)
    except ValueError:
        return path
