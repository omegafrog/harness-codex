"""Document handoff contract validators for dashboard gates."""

from __future__ import annotations

import json
import re
from dataclasses import asdict
from pathlib import Path
from typing import Any, Iterable, Mapping

from harness_codex.runtime.changes import ChangeSetResolver
from harness_codex.runtime.changes.models import (
    AffectedWorkItem,
    ChangeSet,
    WorkItemType,
)
from harness_codex.runtime.models import (
    ContractValidationResult,
    ContractValidationSeverity,
    ContractValidationStatus,
)


USE_CASE_E2E_ALIGNMENT = "use_case_e2e_alignment"
TECHNICAL_DECISION_PLAN_COVERAGE = "technical_decision_plan_coverage"
CHANGESET_SLICE_PATH_CONTRACT = "changeset_slice_path_contract"
PLAN_RUN_EVIDENCE_CONTRACT = "plan_run_evidence_contract"

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_-]{2,}")
_STOPWORDS = {
    "add",
    "all",
    "and",
    "are",
    "before",
    "but",
    "can",
    "case",
    "change",
    "changeset",
    "command",
    "complete",
    "decision",
    "decisions",
    "document",
    "e2e",
    "end",
    "for",
    "from",
    "goal",
    "has",
    "have",
    "implementation",
    "into",
    "must",
    "not",
    "one",
    "path",
    "plan",
    "required",
    "result",
    "shall",
    "status",
    "system",
    "task",
    "test",
    "that",
    "the",
    "then",
    "this",
    "use",
    "user",
    "when",
    "with",
}
_COVERAGE_WORDS = (
    "implement",
    "implementation",
    "add",
    "test",
    "failure",
    "verify",
    "verification",
    "assert",
    "cover",
)


def validate_contracts(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str | None = None,
) -> tuple[ContractValidationResult, ...]:
    """Validate dashboard-ready document handoff contracts for one ChangeSet."""

    root = Path(repo_root)
    resolver = ChangeSetResolver(root)
    change_set = resolver.load(Path("docs/changes/active") / f"{change_set_id}.md")
    work_items = _selected_work_items(change_set, work_item_id)

    results: list[ContractValidationResult] = []
    results.extend(validate_changeset_slice_paths(root, change_set, work_items))
    for work_item in work_items:
        if work_item.work_item_type == WorkItemType.USE_CASE:
            results.append(validate_use_case_e2e_alignment(root, work_item))
            results.append(validate_technical_decision_plan_coverage(root, work_item))
        results.append(validate_plan_run_evidence(root, change_set, work_item))
    return tuple(results)


def validate_changeset_slice_paths(
    repo_root: Path | str,
    change_set: ChangeSet,
    work_items: Iterable[AffectedWorkItem] | None = None,
) -> tuple[ContractValidationResult, ...]:
    """Check ChangeSet affected work-item paths point at expected slice dirs."""

    root = Path(repo_root)
    items = tuple(work_items or change_set.ordered_work_items())
    change_set_path = change_set.path or Path("docs/changes/active") / f"{change_set.change_set_id}.md"
    results: list[ContractValidationResult] = []

    for item in items:
        expected = _expected_slice_path(item)
        actual = _normalize_slice_path(item.slice_path)
        evidence = (f"{item.work_item_id}: {item.slice_path}",)
        if actual != expected:
            results.append(
                _fail(
                    CHANGESET_SLICE_PATH_CONTRACT,
                    change_set_path,
                    item.slice_path,
                    (
                        f"ChangeSet work item {item.work_item_id} points to "
                        f"{item.slice_path} instead of {expected}."
                    ),
                    evidence,
                )
            )
            continue

        if not (root / actual).is_dir():
            results.append(
                _fail(
                    CHANGESET_SLICE_PATH_CONTRACT,
                    change_set_path,
                    actual,
                    f"ChangeSet work item {item.work_item_id} slice path does not exist: {actual}.",
                    evidence,
                )
            )
            continue

        results.append(
            _pass(
                CHANGESET_SLICE_PATH_CONTRACT,
                change_set_path,
                actual,
                evidence,
            )
        )

    return tuple(results)


def validate_use_case_e2e_alignment(
    repo_root: Path | str,
    work_item: AffectedWorkItem,
) -> ContractValidationResult:
    """Check use-case and E2E goal documents describe same business outcome."""

    root = Path(repo_root)
    use_case_path = work_item.slice_path / "use-case.md"
    e2e_goal_path = work_item.slice_path / "e2e-goal.md"
    missing = _missing_files(root, (use_case_path, e2e_goal_path))
    if missing:
        return _fail(
            USE_CASE_E2E_ALIGNMENT,
            use_case_path,
            e2e_goal_path,
            "Missing contract input files: " + ", ".join(missing) + ".",
            tuple(missing),
        )

    use_case_text = (root / use_case_path).read_text(encoding="utf-8")
    e2e_goal_text = (root / e2e_goal_path).read_text(encoding="utf-8")
    use_case_terms = _keywords(use_case_text)
    e2e_terms = _keywords(e2e_goal_text)
    overlap = sorted(use_case_terms & e2e_terms)
    required_overlap = 2 if min(len(use_case_terms), len(e2e_terms)) >= 4 else 1

    if len(overlap) < required_overlap:
        use_only = sorted(use_case_terms - e2e_terms)[:6]
        e2e_only = sorted(e2e_terms - use_case_terms)[:6]
        return _fail(
            USE_CASE_E2E_ALIGNMENT,
            use_case_path,
            e2e_goal_path,
            (
                "E2E goal appears to verify different outcome terms than the use case: "
                f"use-case={', '.join(use_only) or '-'}; e2e={', '.join(e2e_only) or '-'}."
            ),
            (
                f"use_case_terms={', '.join(sorted(use_case_terms)[:12])}",
                f"e2e_goal_terms={', '.join(sorted(e2e_terms)[:12])}",
            ),
        )

    return _pass(
        USE_CASE_E2E_ALIGNMENT,
        use_case_path,
        e2e_goal_path,
        (f"shared_terms={', '.join(overlap[:12])}",),
    )


def validate_technical_decision_plan_coverage(
    repo_root: Path | str,
    work_item: AffectedWorkItem,
) -> ContractValidationResult:
    """Check approved technical decisions appear in implementation plan tasks."""

    root = Path(repo_root)
    decision_path = work_item.slice_path / "technical-decisions.md"
    plan_path = _plan_path(root, work_item.work_item_id)
    missing = _missing_files(root, (decision_path, plan_path))
    if missing:
        return _fail(
            TECHNICAL_DECISION_PLAN_COVERAGE,
            decision_path,
            plan_path,
            "Missing contract input files: " + ", ".join(missing) + ".",
            tuple(missing),
        )

    decision_text = (root / decision_path).read_text(encoding="utf-8")
    plan_text = (root / plan_path).read_text(encoding="utf-8")
    decisions = _approved_decisions(decision_text)
    if not decisions:
        return _pass(
            TECHNICAL_DECISION_PLAN_COVERAGE,
            decision_path,
            plan_path,
            ("No approved decisions found.",),
            severity=ContractValidationSeverity.INFO,
        )

    uncovered: list[str] = []
    for decision in decisions:
        terms = _keywords(decision)
        if not _plan_covers_decision(plan_text, terms):
            uncovered.append(decision)

    if uncovered:
        return _fail(
            TECHNICAL_DECISION_PLAN_COVERAGE,
            decision_path,
            plan_path,
            "Approved technical decisions lack implementation, test, or verification plan coverage.",
            tuple(uncovered[:5]),
        )

    return _pass(
        TECHNICAL_DECISION_PLAN_COVERAGE,
        decision_path,
        plan_path,
        tuple(decisions[:5]),
    )


def validate_plan_run_evidence(
    repo_root: Path | str,
    change_set: ChangeSet,
    work_item: AffectedWorkItem,
) -> ContractValidationResult:
    """Check plan has structured run evidence when runtime reports exist."""

    root = Path(repo_root)
    plan_path = _plan_path(root, work_item.work_item_id)
    if not (root / plan_path).is_file():
        return _fail(
            PLAN_RUN_EVIDENCE_CONTRACT,
            plan_path,
            Path(".harness/runs"),
            f"Plan not found for work item {work_item.work_item_id}: {plan_path}.",
            (str(plan_path),),
        )

    report_path, item_report = _latest_work_item_report(
        root,
        change_set.change_set_id,
        work_item.work_item_id,
    )
    if item_report is None:
        return _pass(
            PLAN_RUN_EVIDENCE_CONTRACT,
            plan_path,
            Path(".harness/runs"),
            ("No run evidence found yet.",),
            severity=ContractValidationSeverity.INFO,
        )

    missing_fields = [
        field_name
        for field_name in ("status", "verification_result")
        if not str(item_report.get(field_name) or "").strip()
    ]
    missing_artifacts = _missing_artifact_paths(root, item_report)
    if missing_fields or missing_artifacts:
        problems = []
        if missing_fields:
            problems.append("missing fields: " + ", ".join(missing_fields))
        if missing_artifacts:
            problems.append("missing artifacts: " + ", ".join(missing_artifacts))
        return _fail(
            PLAN_RUN_EVIDENCE_CONTRACT,
            plan_path,
            report_path or Path(".harness/runs"),
            "; ".join(problems) + ".",
            (str(report_path or ""),),
        )

    return _pass(
        PLAN_RUN_EVIDENCE_CONTRACT,
        plan_path,
        report_path or Path(".harness/runs"),
        (
            f"status={item_report.get('status')}",
            f"verification_result={item_report.get('verification_result')}",
        ),
    )


def contract_results_to_json(results: Iterable[ContractValidationResult]) -> str:
    """Serialize contract results for dashboard projections and CLI output."""

    return json.dumps([_to_json(result) for result in results], ensure_ascii=False, indent=2) + "\n"


def format_contract_results(results: Iterable[ContractValidationResult]) -> str:
    """Format contract validation results for human CLI output."""

    lines: list[str] = []
    for result in results:
        lines.append(
            f"{result.status.value.upper()} {result.contract_id}: "
            f"{result.from_path} -> {result.to_path} severity={result.severity.value}"
        )
        if result.blocker:
            lines.append(f"  blocker: {result.blocker}")
        for evidence in result.evidence:
            lines.append(f"  evidence: {evidence}")
    return "\n".join(lines)


def _selected_work_items(
    change_set: ChangeSet,
    work_item_id: str | None,
) -> tuple[AffectedWorkItem, ...]:
    items = change_set.ordered_work_items()
    if not work_item_id:
        return items
    selected = tuple(item for item in items if item.work_item_id == work_item_id)
    if not selected:
        raise ValueError(f"{work_item_id} is not affected by {change_set.change_set_id}")
    return selected


def _expected_slice_path(item: AffectedWorkItem) -> Path:
    if item.work_item_type == WorkItemType.USE_CASE:
        return Path("docs/use-cases") / item.work_item_id
    return Path("docs/maintenance") / item.work_item_id


def _normalize_slice_path(path: Path) -> Path:
    return Path(str(path).rstrip("/"))


def _plan_path(repo_root: Path, work_item_id: str) -> Path:
    active = Path("docs/plans/active") / work_item_id / "plan.md"
    if (repo_root / active).is_file():
        return active
    completed = Path("docs/plans/completed") / work_item_id / "plan.md"
    if (repo_root / completed).is_file():
        return completed
    return active


def _missing_files(repo_root: Path, paths: Iterable[Path]) -> list[str]:
    return [str(path) for path in paths if not (repo_root / path).is_file()]


def _keywords(text: str) -> set[str]:
    return {
        word.lower().replace("-", "_")
        for word in _WORD_RE.findall(text)
        if word.lower() not in _STOPWORDS and len(word) > 3
    }


def _approved_decisions(text: str) -> tuple[str, ...]:
    decisions: list[str] = []
    in_approved_section = False
    for line in text.splitlines():
        stripped = line.strip()
        lowered = stripped.lower()
        if stripped.startswith("#"):
            in_approved_section = "approved" in lowered and "decision" in lowered
            continue
        if "approved decision:" in lowered:
            decisions.append(stripped.split(":", maxsplit=1)[1].strip())
            continue
        if in_approved_section and stripped.startswith(("-", "*")):
            value = stripped.lstrip("-* ").strip()
            if value and value.lower() not in {"none", "n/a"}:
                decisions.append(value)
    return tuple(dict.fromkeys(decisions))


def _plan_covers_decision(plan_text: str, decision_terms: set[str]) -> bool:
    if not decision_terms:
        return True
    lowered_plan = plan_text.lower()
    if not any(term.replace("_", "-") in lowered_plan or term in lowered_plan for term in decision_terms):
        return False
    required_overlap = 2 if len(decision_terms) >= 2 else 1
    for line in plan_text.splitlines():
        lowered = line.lower()
        if not any(word in lowered for word in _COVERAGE_WORDS):
            continue
        overlap = sum(
            1
            for term in decision_terms
            if term.replace("_", "-") in lowered or term in lowered
        )
        if overlap >= required_overlap:
            return True
    return False


def _latest_work_item_report(
    repo_root: Path,
    change_set_id: str,
    work_item_id: str,
) -> tuple[Path | None, Mapping[str, Any] | None]:
    runs_dir = repo_root / ".harness/runs"
    if not runs_dir.exists():
        return None, None

    reports = sorted(
        runs_dir.glob("*/report.json"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for report_path in reports:
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if report.get("change_set_id") != change_set_id:
            continue
        for item in report.get("work_item_reports") or ():
            if item.get("work_item_id") == work_item_id:
                return report_path.relative_to(repo_root), item
    return None, None


def _missing_artifact_paths(repo_root: Path, item_report: Mapping[str, Any]) -> list[str]:
    raw_paths = item_report.get("artifact_paths") or {}
    if not isinstance(raw_paths, Mapping):
        return []
    missing: list[str] = []
    for value in raw_paths.values():
        path = Path(str(value))
        if not (repo_root / path).exists():
            missing.append(str(path))
    return missing


def _pass(
    contract_id: str,
    from_path: Path,
    to_path: Path,
    evidence: tuple[str, ...],
    *,
    severity: ContractValidationSeverity = ContractValidationSeverity.INFO,
) -> ContractValidationResult:
    return ContractValidationResult(
        contract_id=contract_id,
        from_path=from_path,
        to_path=to_path,
        status=ContractValidationStatus.PASS,
        severity=severity,
        evidence=evidence,
    )


def _fail(
    contract_id: str,
    from_path: Path,
    to_path: Path,
    blocker: str,
    evidence: tuple[str, ...],
) -> ContractValidationResult:
    return ContractValidationResult(
        contract_id=contract_id,
        from_path=from_path,
        to_path=to_path,
        status=ContractValidationStatus.FAIL,
        severity=ContractValidationSeverity.BLOCKING,
        blocker=blocker,
        evidence=evidence,
    )


def _to_json(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, ContractValidationStatus | ContractValidationSeverity):
        return value.value
    if isinstance(value, tuple):
        return [_to_json(item) for item in value]
    if isinstance(value, ContractValidationResult):
        return {
            "contract_id": value.contract_id,
            "from": str(value.from_path),
            "to": str(value.to_path),
            "status": value.status.value,
            "severity": value.severity.value,
            "blocker": value.blocker,
            "evidence": list(value.evidence),
        }
    if hasattr(value, "__dataclass_fields__"):
        return {key: _to_json(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {key: _to_json(item) for key, item in value.items()}
    return value
