from __future__ import annotations

import json
import re
from dataclasses import dataclass
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable, Mapping

from harness_codex.runtime.episode import read_run_episodes
from harness_codex.runtime.changeset_memory import (
    ChangeSetMemoryError,
    create_verified_memory_document,
    current_repository_revision,
)

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
class EvolutionImprovement:
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
    experience_dir = EVOLUTION_ROOT / "experiences" / change_set_id / work_item_id / run_id
    absolute_experience_dir = root / experience_dir
    absolute_experience_dir.mkdir(parents=True, exist_ok=True)
    target_path = EVOLUTION_ROOT / "components" / classification.component / f"{proposal_id}.md"

    _write_experience_files(
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
    normalized = event if isinstance(event, IntentFeedbackEvent) else _normalize_intent_feedback(event)
    return EvolutionClassification(
        "eligible",
        "User correction exposed an implementation-intent mismatch "
        f"during {normalized.interaction_phase}.",
        MISALIGNMENT_COMPONENTS[normalized.misalignment_kind],
    )


def classify_failure_for_evolution(text: str) -> EvolutionClassification:
    return EvolutionClassification(
        "not_eligible",
        "Verifier, test, contract, implementation, and environment failures "
        "must use existing repair gates, not evolution.",
        "verification",
    )


def evolution_metrics(
    repo_root: Path | str,
    *,
    run_id: str | None = None,
    change_set_id: str | None = None,
) -> dict[str, Any]:
    """Episode 기반 품질/효율 지표를 계산한다."""

    episodes = _filtered_episodes(
        Path(repo_root),
        run_id=run_id,
        change_set_id=change_set_id,
    )
    if not episodes:
        raise EvolutionError("matching run episodes not found")

    total = len(episodes)
    first_pass = sum(1 for item in episodes if item.get("final_status") == "succeeded")
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
    return {
        "episode_count": total,
        "first_run_pass_rate": round(first_pass / total, 4),
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
    """반복 run episode 실패 패턴을 기존 EVO proposal로 변환한다."""

    root = Path(repo_root)
    if change_set_id is not None:
        _validate_identifier("change_set_id", change_set_id)
    if work_item_id is not None:
        _validate_identifier("work_item_id", work_item_id)
    episodes = _filtered_episodes(root, change_set_id=change_set_id, work_item_id=work_item_id)
    candidates = [
        item
        for item in episodes
        if item.get("failure_class")
        and item.get("failure_class") != "environment_blocker"
        and item.get("failure_fingerprint")
    ]
    if not candidates:
        raise EvolutionError("no eligible non-environment failure episodes found")
    grouped: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    for item in candidates:
        grouped[str(item["failure_fingerprint"])].append(item)
    fingerprint, matches = max(grouped.items(), key=lambda entry: (len(entry[1]), entry[0]))
    if len(matches) < max(min_count, 1):
        raise EvolutionError(
            f"no repeated failure pattern reached min-count={min_count}"
        )

    selected_change_set_id = change_set_id or str(matches[0].get("changeset_id") or "unknown-changeset")
    selected_work_item_id = work_item_id or _first_work_item_id(matches[0])
    if not selected_work_item_id:
        raise EvolutionError("matching episode has no work item id")
    proposal_id = _next_proposal_id(root)
    first_run_id = str(matches[0].get("run_id"))
    classification = EvolutionClassification(
        "eligible",
        "Repeated non-environment run episode failure pattern qualifies for evolution review.",
        _component_for_failure(str(matches[0].get("failure_class"))),
    )
    target_path = EVOLUTION_ROOT / "components" / classification.component / f"{proposal_id}.md"
    experience_dir = EVOLUTION_ROOT / "experiences" / selected_change_set_id / selected_work_item_id / first_run_id
    absolute_experience_dir = root / experience_dir
    absolute_experience_dir.mkdir(parents=True, exist_ok=True)
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
    """반복 episode 패턴을 찾아 replay 후 바로 canary 승격한다."""

    proposal = propose_evolution_from_episodes(
        repo_root,
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        min_count=min_count,
    )
    replay_path = replay_evolution(repo_root, proposal.proposal_id)
    scope = canary_scope or _canary_scope_from_proposal(Path(repo_root), proposal.proposal_path)
    promotion_state_path = promote_evolution(
        repo_root,
        proposal.proposal_id,
        canary_scope=scope,
    )
    return EvolutionImprovement(
        proposal=proposal,
        replay_path=replay_path,
        promotion_state_path=promotion_state_path,
        canary_scope=scope,
    )


def replay_evolution(repo_root: Path | str, proposal_id: str) -> Path:
    """후보를 과거 episode 메타데이터 기준으로 평가 기록한다."""

    root = Path(repo_root)
    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    text = _read_proposal(root, proposal_path)
    source = _safe_markdown_field(text, "Source") or "intent_feedback"
    run_ids = re.findall(r"Run ID: `([^`]+)`", text)
    passed = source == "run_episode_pattern" and bool(run_ids)
    output = EVOLUTION_ROOT / "evaluations" / proposal_id / "replay-result.json"
    absolute_output = root / output
    absolute_output.parent.mkdir(parents=True, exist_ok=True)
    absolute_output.write_text(
        json.dumps(
            {
                "proposal_id": proposal_id,
                "source": source,
                "status": "passed" if passed else "blocked",
                "evaluated_run_ids": run_ids,
                "reason": (
                    "episode metadata replay baseline available"
                    if passed
                    else "run episode evidence missing"
                ),
            },
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return output


def promote_evolution(
    repo_root: Path | str,
    proposal_id: str,
    *,
    canary_scope: str,
) -> Path:
    """통과한 replay 결과를 accepted guidance와 canary 상태로 승격한다."""

    root = Path(repo_root)
    _validate_identifier("proposal_id", proposal_id)
    if not canary_scope.strip():
        raise EvolutionError("canary scope must be non-empty")
    replay_path = root / EVOLUTION_ROOT / "evaluations" / proposal_id / "replay-result.json"
    replay = _read_json(replay_path)
    if replay.get("status") != "passed":
        raise EvolutionError("replay must pass before promotion")
    accepted_path, target_path = accept_evolution(root, proposal_id)
    state_path = _write_promotion_state(
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
    return state_path


def rollback_evolution(repo_root: Path | str, proposal_id: str) -> Path:
    """승격된 guidance 파일을 제거하고 rollback 상태를 기록한다."""

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


def _filtered_episodes(
    root: Path,
    *,
    run_id: str | None = None,
    change_set_id: str | None = None,
    work_item_id: str | None = None,
) -> tuple[Mapping[str, Any], ...]:
    episodes = read_run_episodes(root)
    selected = []
    for episode in episodes:
        if run_id and episode.get("run_id") != run_id:
            continue
        if change_set_id and episode.get("changeset_id") != change_set_id:
            continue
        work_item_ids = episode.get("work_item_ids", [])
        if work_item_id and work_item_id not in [str(item) for item in work_item_ids]:
            continue
        selected.append(episode)
    return tuple(selected)


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
    run_lines = [f"- `{item.get('run_id')}`: `{item.get('failure_class')}`" for item in items]
    (experience_dir / "trajectory-summary.md").write_text(
        "\n".join(
            (
                f"# Episode Pattern Summary: {fingerprint}",
                "",
                f"- ChangeSet: `{change_set_id}`",
                f"- Work item: `{work_item_id}`",
                f"- Pattern count: `{len(items)}`",
                "- Status: repeated run episode failure selected for evolution review",
                "",
                "## Runs",
                "",
                *run_lines,
            )
        )
        + "\n",
        encoding="utf-8",
    )
    (experience_dir / "episodes.json").write_text(
        json.dumps(items, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (experience_dir / "episode-analysis.md").write_text(
        "\n".join(
            (
                "# Episode Pattern Analysis",
                "",
                f"- Classification: `{classification.status}`",
                f"- Component: `{classification.component}`",
                f"- Reason: {classification.reason}",
                f"- Failure fingerprint: `{fingerprint}`",
            )
        )
        + "\n",
        encoding="utf-8",
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
    repeated_stage = _dominant_failed_stage(items)
    failed_gates = _dominant_verification_values(items, "failed_gates")
    unmet_obligations = _dominant_verification_values(items, "unmet_obligations")
    failed_commands = _dominant_failed_commands(items)
    reusable_rule = _episode_reusable_rule(
        failure_class=str(items[0].get("failure_class") or ""),
        repeated_stage=repeated_stage,
        failed_gates=failed_gates,
        unmet_obligations=unmet_obligations,
        failed_commands=failed_commands,
    )
    run_lines = "\n".join(
        f"- Run ID: `{item.get('run_id')}` failure_class=`{item.get('failure_class')}`"
        for item in items
    )
    evidence_lines = [
        f"- Failure fingerprint: `{fingerprint}`",
        f"- Pattern count: `{len(items)}`",
    ]
    if repeated_stage:
        evidence_lines.append(f"- Repeated failed stage: `{repeated_stage}`")
    if failed_gates:
        evidence_lines.append(f"- Failed gates: `{', '.join(failed_gates)}`")
    if failed_commands:
        evidence_lines.append(f"- Failed commands: `{', '.join(failed_commands)}`")
    if unmet_obligations:
        evidence_lines.append(f"- Unmet obligations: `{', '.join(unmet_obligations)}`")
    return (
        f"# Evolution Proposal: {proposal_id}\n\n"
        "## Observed Run Episode Pattern\n\n"
        f"{classification.reason}\n\n"
        "## Affected Workflow Step\n\n"
        f"- ChangeSet: `{change_set_id}`\n"
        f"- Work item: `{work_item_id}`\n"
        f"- Run: `{items[0].get('run_id')}`\n"
        "- Source: `run_episode_pattern`\n\n"
        "## Episode Evidence\n\n"
        f"{chr(10).join(evidence_lines)}\n"
        f"{run_lines}\n\n"
        "## Proposed Mutable Component Change\n\n"
        f"- Classification: `{classification.status}`\n"
        f"- Component: `{classification.component}`\n"
        f"- Target path: `{target_path}`\n"
        "- Change: Add reviewable workflow or instruction guidance for the repeated failure pattern.\n"
        f"- Reusable rule: {reusable_rule}\n\n"
        "## Expected Impact\n\n"
        "- Similar future runs should reduce repeated verification failure and remediation cycles.\n\n"
        "## Validation Method\n\n"
        "- Run `harness evolution replay` against recorded run episodes.\n"
        "- Promote only when replay result is `passed`.\n"
        "- Use canary scope before default workflow or instruction promotion.\n\n"
        "## Rollback Method\n\n"
        f"- Run `harness evolution rollback {proposal_id}` and remove `{target_path}` if materialized.\n\n"
        "## Reviewer Decision\n\n"
        "- Reviewer decision: `pending`\n\n"
        "## Long-Term Memory Sync\n\n"
        "- Status: `pending_review`\n"
        "- Memory record: `-`\n"
    )


def _component_for_failure(failure_class: str) -> str:
    if failure_class in {"verification_goal_unclear", "scope_conflict"}:
        return "verification"
    return "runner-policy"


def _dominant_failed_stage(episodes: Iterable[Mapping[str, Any]]) -> str:
    stages = []
    for episode in episodes:
        for stage in episode.get("stages", []):
            if not isinstance(stage, Mapping):
                continue
            result = str(stage.get("result") or "")
            failure_kind = stage.get("failure_kind")
            if result in {"failed", "blocked"} or failure_kind:
                name = stage.get("name")
                if isinstance(name, str) and name:
                    stages.append(name)
    if not stages:
        return ""
    return Counter(stages).most_common(1)[0][0]


def _dominant_verification_values(
    episodes: Iterable[Mapping[str, Any]],
    key: str,
) -> tuple[str, ...]:
    values: list[str] = []
    for episode in episodes:
        verification = episode.get("verification", {})
        reports = verification.get("reports", []) if isinstance(verification, Mapping) else []
        if not isinstance(reports, list):
            continue
        for report in reports:
            if not isinstance(report, Mapping):
                continue
            raw_values = report.get(key, [])
            if isinstance(raw_values, list):
                values.extend(str(item) for item in raw_values if str(item).strip())
    return tuple(item for item, _count in Counter(values).most_common(5))


def _dominant_failed_commands(episodes: Iterable[Mapping[str, Any]]) -> tuple[str, ...]:
    commands: list[str] = []
    for episode in episodes:
        verification = episode.get("verification", {})
        reports = verification.get("reports", []) if isinstance(verification, Mapping) else []
        if not isinstance(reports, list):
            continue
        for report in reports:
            if not isinstance(report, Mapping):
                continue
            failed_commands = report.get("failed_commands", [])
            if not isinstance(failed_commands, list):
                continue
            for command in failed_commands:
                if isinstance(command, Mapping) and command.get("command"):
                    commands.append(str(command["command"]))
    return tuple(item for item, _count in Counter(commands).most_common(5))


def _episode_reusable_rule(
    *,
    failure_class: str,
    repeated_stage: str,
    failed_gates: tuple[str, ...],
    unmet_obligations: tuple[str, ...],
    failed_commands: tuple[str, ...],
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
        return (
            "Before `materialize-execution-scope`, ensure the active plan has executable unchecked tasks "
            "and stays inside the selected work-item scope."
        )
    if repeated_stage == "review-work-item-plan":
        return (
            "Before execution, resolve plan-review rejection findings and rerun the plan review until approved."
        )
    if repeated_stage:
        return (
            f"Before leaving `{repeated_stage}`, verify its required artifact contract and repair the repeated "
            "failure pattern in that stage."
        )
    if failure_class == "verification_goal_unclear":
        return "Clarify the verification goal before planning or execution changes proceed."
    if failure_class == "scope_conflict":
        return "Resolve ChangeSet/work-item scope conflict before implementation handoff."
    return "Prevent the repeated failure pattern before execution reaches verification."


def _first_work_item_id(episode: Mapping[str, Any]) -> str:
    values = episode.get("work_item_ids", [])
    if isinstance(values, list) and values:
        return str(values[0])
    return ""


def _canary_scope_from_proposal(root: Path, proposal_path: Path) -> str:
    text = _read_proposal(root, proposal_path)
    work_item_id = _safe_markdown_field(text, "Work item")
    if work_item_id and work_item_id != "unknown":
        return f"work-item:{work_item_id}"
    change_set_id = _safe_markdown_field(text, "ChangeSet")
    if change_set_id and change_set_id != "unknown":
        return f"change-set:{change_set_id}"
    return "local-run-episodes"


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0
    ordered = sorted(values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    rank = (len(ordered) - 1) * percentile
    lower = int(rank)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = rank - lower
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction, 3)


def _read_proposal(root: Path, proposal_path: Path) -> str:
    absolute = root / proposal_path
    if not absolute.exists():
        raise EvolutionError(f"missing proposal: {proposal_path}")
    return absolute.read_text(encoding="utf-8")


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_promotion_state(root: Path, entry: Mapping[str, Any]) -> Path:
    path = root / EVOLUTION_ROOT / "promotion-state.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    state = _read_json(path)
    history = state.get("history", [])
    if not isinstance(history, list):
        history = []
    history.append(dict(entry))
    state = {"current": dict(entry), "history": history}
    path.write_text(
        json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return _display(path, root)


def _remove_promoted_guidance(root: Path, proposal_id: str) -> tuple[Path, ...]:
    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    text = _read_proposal(root, proposal_path)
    target_path = _target_path_from_proposal(text)
    paths = (EVOLUTION_ROOT / "accepted" / f"{proposal_id}.md", target_path)
    removed = []
    for path in paths:
        absolute = root / path
        try:
            if absolute.exists():
                absolute.unlink()
                removed.append(path)
        except OSError as error:
            raise EvolutionError(f"failed to remove promoted guidance: {path}") from error
    proposal_absolute = root / proposal_path
    proposal_absolute.write_text(_set_reviewer_decision(text, "rolled_back"), encoding="utf-8")
    return tuple(removed)


def accept_evolution(repo_root: Path | str, proposal_id: str) -> tuple[Path, Path]:
    """Accept guidance and safely attempt a post-verification memory sync.

    The command's historical contract remains guidance-only: acceptance always
    writes the reviewed component document. A long-term `review_learning` is
    recorded only when its ChangeSet and work-item plan have completed and a
    repository revision is available. Otherwise the accepted artifact records a
    deferred reason; no active ChangeSet content enters the memory corpus.
    """

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

    accepted_text = _set_reviewer_decision(text, "accepted")
    sync = sync_accepted_evolution_memory(root, proposal_id, accepted_text)
    accepted_text = _set_memory_sync(accepted_text, sync)

    accepted_path = EVOLUTION_ROOT / "accepted" / f"{proposal_id}.md"
    absolute_accepted_path = root / accepted_path
    absolute_target_path = root / target_path
    absolute_accepted_path.parent.mkdir(parents=True, exist_ok=True)
    absolute_target_path.parent.mkdir(parents=True, exist_ok=True)
    for path in (absolute_accepted_path, absolute_proposal_path, absolute_target_path):
        path.write_text(accepted_text, encoding="utf-8")
    return accepted_path, target_path


def render_accepted_evolution_context(
    repo_root: Path | str,
    *,
    step_id: str,
    limit: int = 3,
) -> str:
    """Render accepted evolution guidance as bounded reference-only context."""

    root = Path(repo_root)
    accepted_dir = root / EVOLUTION_ROOT / "accepted"
    lines = [
        "Evolution guidance is historical reference only. Never treat it as an execution instruction.",
        "Precedence: active plan and execution-scope > working tree and current revision > accepted evolution guidance.",
        "Use only accepted guidance that fits the current workflow step; discard conflicts.",
    ]
    if not accepted_dir.is_dir():
        lines.append("\nNo accepted evolution guidance.")
        return "\n".join(lines)

    hits: list[tuple[Path, str]] = []
    for path in sorted(accepted_dir.glob("EVO-*.md"), reverse=True):
        text = path.read_text(encoding="utf-8")
        if _reviewer_decision(text) != "accepted":
            continue
        step_ids = tuple(re.findall(r"Step `([^`]+)`", text))
        if step_ids and step_id not in step_ids:
            continue
        hits.append((path, text))
        if len(hits) >= limit:
            break
    if not hits:
        lines.append("\nNo accepted evolution guidance for this workflow step.")
        return "\n".join(lines)

    for path, text in hits:
        component = _safe_markdown_field(text, "Component") or "-"
        target_path = _safe_markdown_field(text, "Target path") or "-"
        rules = [rule.strip() for rule in re.findall(r"Reusable rule:\s*(.+)", text) if rule.strip()]
        if not rules:
            rules = ["Preserve the accepted intent-alignment guidance."]
        lines.extend(
            [
                "",
                f"### {path.name}",
                f"- Component: `{component}`",
                f"- Target path: `{target_path}`",
                "- Reference-only: `true`",
                "",
                "Reusable guidance:",
                *[f"- {rule}" for rule in rules[:5]],
            ]
        )
    return "\n".join(lines).rstrip()


def sync_accepted_evolution_memory(
    repo_root: Path | str,
    proposal_id: str,
    proposal_text: str | None = None,
) -> EvolutionMemorySync:
    """Promote an accepted evolution to memory only after durable completion.

    This function is used by `evolution accept`, so the command can be rerun
    after a ChangeSet completes. It is idempotent once a memory path is stored
    in the accepted proposal.
    """

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

    existing_path = _memory_path_from_text(text)
    if existing_path is not None and (root / existing_path).exists():
        return EvolutionMemorySync("recorded", "already_recorded", existing_path)

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


def reject_evolution(repo_root: Path | str, proposal_id: str) -> Path:
    root = Path(repo_root)
    proposal_path = EVOLUTION_ROOT / "proposals" / f"{proposal_id}.md"
    absolute_proposal_path = root / proposal_path
    if not absolute_proposal_path.exists():
        raise EvolutionError(f"missing proposal: {proposal_path}")
    text = absolute_proposal_path.read_text(encoding="utf-8")
    absolute_proposal_path.write_text(_set_reviewer_decision(text, "rejected"), encoding="utf-8")
    return proposal_path


def _collect_intent_feedback(run_dir: Path, work_item_id: str) -> tuple[IntentFeedbackEvent, ...]:
    feedback_path = run_dir / INTENT_FEEDBACK_FILE
    if not feedback_path.exists():
        return ()
    events: list[IntentFeedbackEvent] = []
    for line_number, line in enumerate(feedback_path.read_text(encoding="utf-8").splitlines(), start=1):
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
            (
                f"# Trajectory Summary: {run_id}",
                "",
                f"- ChangeSet: `{change_set_id}`",
                f"- Work item: `{work_item_id}`",
                f"- Run: `{run_id}`",
                "- Status: implementation-intent correction selected for evolution review",
            )
        ) + "\n",
        encoding="utf-8",
    )
    (experience_dir / "intent-feedback.json").write_text(
        json.dumps([item.__dict__ for item in feedback_items], indent=2, ensure_ascii=True) + "\n",
        encoding="utf-8",
    )
    (experience_dir / "intent-analysis.md").write_text(
        "\n".join(
            (
                "# Intent Alignment Analysis",
                "",
                f"- Classification: `{classification.status}`",
                f"- Component: `{classification.component}`",
                f"- Reason: {classification.reason}",
            )
        ) + "\n",
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
        f"- Step `{item.step_id}` ({item.interaction_phase}, {item.misalignment_kind}): "
        f"{item.correction} Reusable rule: {item.reusable_rule}"
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
        "- Reviewer decision: `pending`\n\n"
        "## Long-Term Memory Sync\n\n"
        "- Status: `pending_review`\n"
        "- Memory record: `-`\n"
    )


def _proposal_context(text: str) -> dict[str, str]:
    return {
        "change_set_id": _markdown_field(text, "ChangeSet"),
        "work_item_id": _markdown_field(text, "Work item"),
        "run_id": _markdown_field(text, "Run"),
        "component": _markdown_field(text, "Component"),
    }


def _markdown_field(text: str, label: str) -> str:
    match = re.search(rf"- {re.escape(label)}:\s*`([^`]+)`", text)
    if not match:
        raise EvolutionError(f"proposal missing {label}")
    return match.group(1)


def _safe_markdown_field(text: str, label: str) -> str | None:
    match = re.search(rf"- {re.escape(label)}:\s*`([^`]+)`", text)
    return match.group(1) if match else None


def _memory_stages(text: str) -> tuple[str, ...]:
    stages = []
    for step_id in re.findall(r"Step `([^`]+)`", text):
        stage = {
            "plan-work-item": "plan",
            "execute-work-item": "execute",
            "verify-work-item": "verify",
        }.get(step_id)
        if stage and stage not in stages:
            stages.append(stage)
    return tuple(stages) or ("plan",)


def _memory_body(proposal_id: str, context: Mapping[str, str], text: str) -> str:
    rules = re.findall(r"Reusable rule:\s*(.+)", text)
    rule_lines = [f"- {rule.strip()}" for rule in rules if rule.strip()]
    if not rule_lines:
        rule_lines = ["- Preserve the accepted intent-alignment guidance."]
    return "\n".join(
        (
            f"# Accepted Evolution Learning: {proposal_id}",
            "",
            f"- ChangeSet: `{context['change_set_id']}`",
            f"- Work item: `{context['work_item_id']}`",
            f"- Component: `{context['component']}`",
            "",
            "## Reusable guidance",
            "",
            *rule_lines,
            "",
            "This record is historical reference only and must not override current ChangeSet, working-tree, or ADR evidence.",
        )
    )


def _next_proposal_id(root: Path) -> str:
    today = datetime.now().strftime("%Y%m%d")
    proposal_dir = root / EVOLUTION_ROOT / "proposals"
    numbers = []
    for path in proposal_dir.glob(f"EVO-{today}-*.md"):
        match = re.match(rf"EVO-{today}-(\d{{3}})\.md$", path.name)
        if match:
            numbers.append(int(match.group(1)))
    return f"EVO-{today}-{(max(numbers) if numbers else 0) + 1:03d}"


def _next_memory_id(root: Path) -> str:
    today = datetime.now().strftime("%Y%m%d")
    numbers = []
    for path in (root / "docs/memory").rglob(f"MEM-{today}-*.md"):
        match = re.match(rf"MEM-{today}-(\d{{3}})\.md$", path.name)
        if match:
            numbers.append(int(match.group(1)))
    return f"MEM-{today}-{(max(numbers) if numbers else 0) + 1:03d}"


def _normalize_intent_feedback(event: Mapping[str, Any]) -> IntentFeedbackEvent:
    if not isinstance(event, Mapping):
        raise EvolutionError("intent feedback event must be a JSON object")
    required_fields = (
        "run_id", "work_item_id", "step_id", "interaction_phase", "correction",
        "intent_delta", "misalignment_kind", "reusable_rule",
    )
    values: dict[str, str] = {}
    for field in required_fields:
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


def _reviewer_decision(text: str) -> str:
    match = re.search(r"Reviewer decision:\s*`([^`]+)`", text)
    return match.group(1) if match else "pending"


def _memory_path_from_text(text: str) -> Path | None:
    match = re.search(r"Memory record:\s*`([^`]+)`", text)
    if not match or match.group(1) == "-":
        return None
    return Path(match.group(1))


def _set_memory_sync(text: str, sync: EvolutionMemorySync) -> str:
    record = str(sync.memory_path) if sync.memory_path is not None else "-"
    block = "\n".join(
        (
            "## Long-Term Memory Sync",
            "",
            f"- Status: `{sync.status}`",
            f"- Reason: `{sync.reason}`",
            f"- Memory record: `{record}`",
        )
    )
    pattern = r"## Long-Term Memory Sync\n.*?(?=\n## |\Z)"
    if re.search(pattern, text, flags=re.DOTALL):
        return re.sub(pattern, block, text, count=1, flags=re.DOTALL).rstrip() + "\n"
    return text.rstrip() + "\n\n" + block + "\n"


def _validate_component_target(path: Path) -> None:
    parts = path.parts
    if len(parts) < 5 or parts[:3] != (".harness", "evolution", "components"):
        raise EvolutionError("target path must be under .harness/evolution/components/")
    if parts[3] not in ALLOWED_COMPONENTS:
        raise EvolutionError("target component must be one of: " + ", ".join(ALLOWED_COMPONENTS))
    if path.suffix != ".md" or any(part in ("..", "") for part in parts):
        raise EvolutionError("target guidance must be a safe markdown file")


def _set_reviewer_decision(text: str, decision: str) -> str:
    replacement = f"- Reviewer decision: `{decision}`"
    updated, count = re.subn(r"- Reviewer decision:\s*`[^`]+`", replacement, text, count=1)
    return updated if count else text.rstrip() + f"\n\n## Reviewer Decision\n\n{replacement}\n"


def _validate_identifier(name: str, value: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", value):
        raise EvolutionError(f"{name} must be a path-safe identifier")


def _display(path: Path, root: Path) -> Path:
    try:
        return path.relative_to(root)
    except ValueError:
        return path
