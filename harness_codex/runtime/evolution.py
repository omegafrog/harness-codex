from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable


ALLOWED_COMPONENTS = ("agent-context", "skills", "runner-policy", "verification")
EVOLUTION_ROOT = Path(".harness/evolution")


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


def propose_evolution(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
) -> EvolutionProposal:
    root = Path(repo_root)
    run_dir = root / ".harness/runs" / run_id
    if not run_dir.exists():
        raise EvolutionError(f"missing run directory: {_display(run_dir, root)}")

    evidence = _collect_evidence(root, run_dir, work_item_id)
    evidence_text = "\n".join(item.summary for item in evidence)
    classification = classify_failure_for_evolution(evidence_text)
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
        evidence=evidence,
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
            evidence=evidence,
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


def classify_failure_for_evolution(text: str) -> EvolutionClassification:
    normalized = text.lower()
    eligible_rules = (
        (
            ("rediscover", "over-read", "over read", "same context", "context loading"),
            "agent-context",
            "Failure repeats repository context discovery or context loading work.",
        ),
        (
            ("command pattern", "wrong command", "incorrect command", "missing command"),
            "runner-policy",
            "Failure repeats an executable command or runner policy mistake.",
        ),
        (
            ("verification step", "missing verification", "test gate", "no command evidence"),
            "verification",
            "Failure repeats a missed or weak verification step.",
        ),
        (
            ("artifact format", "review status", "contract", "format violation"),
            "skills",
            "Failure repeats an agent artifact or skill-output contract violation.",
        ),
    )
    for keywords, component, reason in eligible_rules:
        if any(keyword in normalized for keyword in keywords):
            return EvolutionClassification("eligible", reason, component)

    not_eligible_rules = (
        "simple implementation bug",
        "unclear business requirement",
        "upstream design",
        "environment blocker",
        "scope conflict",
    )
    if any(keyword in normalized for keyword in not_eligible_rules):
        return EvolutionClassification(
            "not_eligible",
            "Failure looks like implementation, requirement, environment, or upstream-design work.",
            "verification",
        )

    return EvolutionClassification(
        "needs_review",
        "Failure evidence is insufficient for automatic evolution eligibility.",
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


@dataclass(frozen=True)
class _EvidenceItem:
    path: Path
    summary: str


def _collect_evidence(root: Path, run_dir: Path, work_item_id: str) -> tuple[_EvidenceItem, ...]:
    candidates = (
        run_dir / "report.md",
        run_dir / "report.json",
        run_dir / "state.json",
        run_dir / "work-items" / work_item_id / "verification" / "report.json",
        run_dir / "work-items" / work_item_id / "verification" / "verification.md",
    )
    items: list[_EvidenceItem] = []
    for path in candidates:
        if path.exists() and path.is_file():
            items.append(_EvidenceItem(_display(path, root), _summarize_file(path)))
    for path in sorted((run_dir / "steps").glob("*/result.json"))[:8]:
        items.append(_EvidenceItem(_display(path, root), _summarize_file(path)))
    if not items:
        items.append(_EvidenceItem(_display(run_dir, root), "Run directory exists, but no known failure evidence files were found."))
    return tuple(items)


def _write_experience_files(
    root: Path,
    experience_dir: Path,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    evidence: Iterable[_EvidenceItem],
    classification: EvolutionClassification,
) -> None:
    evidence_items = tuple(evidence)
    (experience_dir / "trajectory-summary.md").write_text(
        "\n".join(
            [
                f"# Trajectory Summary: {run_id}",
                "",
                f"- ChangeSet: `{change_set_id}`",
                f"- Work item: `{work_item_id}`",
                f"- Run: `{run_id}`",
                "- Status: failed or blocked run selected for evolution review",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    (experience_dir / "evidence.md").write_text(
        "# Evidence\n\n"
        + "\n".join(f"- `{item.path}`: {item.summary}" for item in evidence_items)
        + "\n",
        encoding="utf-8",
    )
    (experience_dir / "failure-analysis.md").write_text(
        "\n".join(
            [
                "# Failure Analysis",
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
    evidence: Iterable[_EvidenceItem],
    classification: EvolutionClassification,
    target_path: Path,
) -> str:
    evidence_lines = "\n".join(
        f"- `{item.path}`: {item.summary}" for item in evidence
    )
    return (
        f"# Evolution Proposal: {proposal_id}\n\n"
        "## Observed Failure Pattern\n\n"
        f"{classification.reason}\n\n"
        "## Affected Workflow Step\n\n"
        f"- ChangeSet: `{change_set_id}`\n"
        f"- Work item: `{work_item_id}`\n"
        f"- Run: `{run_id}`\n\n"
        "## Evidence\n\n"
        f"{evidence_lines}\n\n"
        "## Proposed Mutable Component Change\n\n"
        f"- Classification: `{classification.status}`\n"
        f"- Component: `{classification.component}`\n"
        f"- Target path: `{target_path}`\n"
        "- Change: Capture this failure pattern as reusable harness guidance.\n\n"
        "## Expected Impact\n\n"
        "- Similar future failures should reach correct context, command, verification, or skill guidance faster.\n\n"
        "## Validation Method\n\n"
        "- Re-run the failed work item and compare verification outcome plus repeated remediation count.\n\n"
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


def _summarize_file(path: Path) -> str:
    text = path.read_text(encoding="utf-8", errors="replace")
    if path.suffix == ".json":
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                keys = ("status", "failure_kind", "failed_step_id", "blocker", "error")
                parts = [f"{key}={data[key]}" for key in keys if key in data and data[key]]
                if parts:
                    return "; ".join(parts)
        except json.JSONDecodeError:
            pass
    compact = " ".join(line.strip() for line in text.splitlines() if line.strip())
    return compact[:240] if compact else "empty file"


def _target_path_from_proposal(text: str) -> Path:
    match = re.search(r"Target path:\s*`([^`]+)`", text)
    if not match:
        raise EvolutionError("proposal missing target path")
    return Path(match.group(1))


def _validate_component_target(path: Path) -> None:
    parts = path.parts
    expected_prefix = (".harness", "evolution", "components")
    if len(parts) < 5 or parts[:3] != expected_prefix:
        raise EvolutionError("target path must be under .harness/evolution/components/")
    if parts[3] not in ALLOWED_COMPONENTS:
        allowed = ", ".join(ALLOWED_COMPONENTS)
        raise EvolutionError(f"target component must be one of: {allowed}")
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
