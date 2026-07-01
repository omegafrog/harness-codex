"""ChangeSet final completion gate and archive workflow."""

from __future__ import annotations

import json
import re
import shutil
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.changes.models import ChangeSet


class ChangeSetCompletionBlocked(RuntimeError):
    """Raised when a ChangeSet is not ready for final completion."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


class PlanCompletionBlocked(RuntimeError):
    """Raised when a work-item plan is not ready for completion."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True)
class ChangeSetCompletionResult:
    """Result of a ChangeSet final completion attempt."""

    change_set_id: str
    active_path: Path
    completed_path: Path
    report_path: Path
    completed_work_items: tuple[str, ...]
    completed_plan_paths: tuple[Path, ...]
    run_id: str | None = None
    already_completed: bool = False


@dataclass(frozen=True)
class PlanCompletionStatus:
    """Read-only projection of whether an active plan can be completed."""

    ready: bool
    blocker: str = ""


_REQUIRED_RESULT_LABELS = (
    "Build",
    "Tests",
    "Focused tests",
    "Architecture test",
    "E2E 또는 maintenance verification",
    "Test gate",
    "Runtime server verification",
    "Static analysis",
)

_REQUIRED_CANONICAL_RESULT_LABELS = (
    "Build",
    "Tests",
    "E2E 또는 maintenance verification",
    "Test gate",
    "Runtime server verification",
    "Static analysis",
)

_RESULT_LABEL_ALIASES = {
    "Tests": ("Tests", "Focused tests"),
}

_REQUIRED_SECTION_ALIASES = (
    ("검증 방법", "집중 검증", "Verification Method", "Focused Verification"),
    ("완료 조건", "Completion Policy"),
    ("검증 결과", "Verification Results"),
)


def validate_plan_completion(
    repo_root: Path | str,
    plan_path: Path | str,
    *,
    run_id: str | None = None,
    change_set_id: str | None = None,
    work_item_id: str | None = None,
) -> None:
    """Block plan completion until the linked execution report is complete."""

    root = Path(repo_root)
    relative_plan_path = Path(plan_path)
    absolute_plan_path = root / relative_plan_path
    if not absolute_plan_path.exists():
        raise PlanCompletionBlocked(f"plan does not exist: {relative_plan_path}")

    text = absolute_plan_path.read_text(encoding="utf-8")
    lines = text.splitlines()

    for aliases in _REQUIRED_SECTION_ALIASES:
        if aliases == ("검증 결과", "Verification Results"):
            continue
        if not any(_has_section(text, section_name) for section_name in aliases):
            raise PlanCompletionBlocked(
                "missing required section: " + " or ".join(aliases)
            )

    if change_set_id and change_set_id not in text:
        raise PlanCompletionBlocked(
            f"plan does not reference active ChangeSet: {change_set_id}"
        )
    if work_item_id and work_item_id not in text:
        raise PlanCompletionBlocked(
            f"plan does not reference selected work item: {work_item_id}"
        )

    if run_id is None and change_set_id:
        run_id = _latest_run_id_for_change_set(root, change_set_id)

    report = _load_execution_report(
        root,
        relative_plan_path=relative_plan_path,
        run_id=run_id,
        work_item_id=work_item_id,
    )
    if report is not None:
        _validate_execution_report(
            root,
            report,
            relative_plan_path=relative_plan_path,
            plan_text=text,
            run_id=run_id,
            work_item_id=work_item_id,
        )
        return

    unchecked = _first_unchecked_checkbox(lines)
    if unchecked is not None:
        line_number, line = unchecked
        raise PlanCompletionBlocked(
            f"missing execution report and unchecked checkbox remains at line {line_number}: {line.strip()}"
        )

    result_section = next(
        (
            section
            for section_name in _REQUIRED_SECTION_ALIASES[-1]
            if (section := _section_body(text, section_name)) is not None
        ),
        None,
    )
    if result_section is None:
        raise PlanCompletionBlocked(
            "missing required section: 검증 결과 or Verification Results"
        )

    evidence_paths: list[Path] = []
    for label in _REQUIRED_CANONICAL_RESULT_LABELS:
        entry = _result_entry(result_section, label)
        if entry is None:
            raise PlanCompletionBlocked(f"missing verification result: {label}")
        if _is_empty_result(entry):
            raise PlanCompletionBlocked(f"empty verification result: {label}")

        not_applicable_error = _not_applicable_error(label, entry)
        if not_applicable_error is not None:
            raise PlanCompletionBlocked(not_applicable_error)

        if _is_not_applicable(entry):
            continue

        entry_paths = _evidence_paths(entry, run_id=run_id)
        if not entry_paths and work_item_id:
            entry_paths = _fallback_evidence_paths(
                root,
                work_item_id=work_item_id,
                label=label,
                run_id=run_id,
            )
        if not entry_paths:
            raise PlanCompletionBlocked(
                f"missing evidence path for verification result: {label}"
            )
        evidence_paths.extend(entry_paths)

    if not evidence_paths:
        raise PlanCompletionBlocked("missing verification evidence under .harness/runs")

    for path in evidence_paths:
        absolute = root / path
        if not absolute.exists():
            raise PlanCompletionBlocked(f"missing evidence artifact: {path}")


def plan_completion_status(
    repo_root: Path | str,
    plan_path: Path | str,
    *,
    run_id: str | None = None,
    change_set_id: str | None = None,
    work_item_id: str | None = None,
) -> PlanCompletionStatus:
    """Return plan completion readiness without mutating active/completed files."""

    relative_plan_path = Path(plan_path)
    if relative_plan_path.parts[:3] == ("docs", "plans", "active"):
        completed_path = Path("docs", "plans", "completed", *relative_plan_path.parts[3:])
        if (Path(repo_root) / completed_path).exists():
            return PlanCompletionStatus(
                ready=False,
                blocker=(
                    "completed plan already exists while active plan remains: "
                    f"{completed_path}"
                ),
            )

    try:
        validate_plan_completion(
            repo_root,
            plan_path,
            run_id=run_id,
            change_set_id=change_set_id,
            work_item_id=work_item_id,
        )
    except PlanCompletionBlocked as exc:
        return PlanCompletionStatus(ready=False, blocker=exc.reason)
    return PlanCompletionStatus(ready=True)


def complete_change_set_if_ready(
    repo_root: Path | str,
    change_set: ChangeSet,
    *,
    run_id: str | None = None,
) -> ChangeSetCompletionResult:
    """Move an active ChangeSet to completed when all work items are done.

    The gate is intentionally fail-closed: it requires completed plans for every
    affected work item, no remaining active plans, and a successful run report.
    Runtime evidence under `.harness/runs` is preserved and a completion report
    is written next to the run report.
    """

    root = Path(repo_root)
    active_path = Path("docs/changes/active") / f"{change_set.change_set_id}.md"
    completed_path = Path("docs/changes/completed") / f"{change_set.change_set_id}.md"
    absolute_active = root / active_path
    absolute_completed = root / completed_path

    work_items = change_set.ordered_work_items()
    work_item_ids = tuple(item.work_item_id for item in work_items)
    completed_plan_paths = tuple(
        Path("docs/plans/completed") / item_id / "plan.md"
        for item_id in work_item_ids
    )

    effective_run_id = run_id or _latest_run_id_for_change_set(root, change_set.change_set_id)
    report_path = (
        Path(".harness/runs") / effective_run_id / "changeset-completion-report.md"
        if effective_run_id
        else Path(".harness/runs/UNKNOWN/changeset-completion-report.md")
    )

    if absolute_completed.exists() and not absolute_active.exists():
        return ChangeSetCompletionResult(
            change_set_id=change_set.change_set_id,
            active_path=active_path,
            completed_path=completed_path,
            report_path=report_path,
            completed_work_items=work_item_ids,
            completed_plan_paths=completed_plan_paths,
            run_id=effective_run_id,
            already_completed=True,
        )

    if absolute_completed.exists() and absolute_active.exists():
        raise ChangeSetCompletionBlocked(
            "completed ChangeSet already exists while active ChangeSet still exists: "
            f"{completed_path}"
        )

    if not absolute_active.exists():
        raise ChangeSetCompletionBlocked(
            f"active ChangeSet file does not exist: {active_path}"
        )

    if change_set.path is not None and change_set.path != active_path:
        raise ChangeSetCompletionBlocked(
            "ChangeSet ID and active path do not match: "
            f"id={change_set.change_set_id} path={change_set.path}"
        )

    if not work_items:
        raise ChangeSetCompletionBlocked("ChangeSet has no affected work items")

    blocked_statuses = tuple(
        f"{item.work_item_id}:{item.status}"
        for item in work_items
        if item.status.strip().lower() in {"failed", "blocked"}
    )
    if blocked_statuses:
        raise ChangeSetCompletionBlocked(
            "affected work items are failed or blocked: "
            + ", ".join(blocked_statuses)
        )

    missing_completed_plans = tuple(
        path for path in completed_plan_paths if not (root / path).exists()
    )
    if missing_completed_plans:
        raise ChangeSetCompletionBlocked(
            "missing completed work item plans: "
            + ", ".join(str(path) for path in missing_completed_plans)
        )

    active_plan_paths = tuple(
        Path("docs/plans/active") / item_id / "plan.md"
        for item_id in work_item_ids
        if (root / "docs/plans/active" / item_id / "plan.md").exists()
    )
    if active_plan_paths:
        raise ChangeSetCompletionBlocked(
            "active work item plans still exist: "
            + ", ".join(str(path) for path in active_plan_paths)
        )

    if effective_run_id is None:
        raise ChangeSetCompletionBlocked(
            f"no run state found for ChangeSet {change_set.change_set_id}"
        )

    run_report, run_report_path = _load_successful_run_report(
        root,
        effective_run_id,
        work_item_ids,
    )

    absolute_completed.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(absolute_active), str(absolute_completed))

    _write_completion_report(
        root,
        report_path,
        change_set=change_set,
        run_id=effective_run_id,
        active_path=active_path,
        completed_path=completed_path,
        completed_work_items=work_item_ids,
        completed_plan_paths=completed_plan_paths,
        run_report_path=run_report_path,
        run_report=run_report,
    )

    return ChangeSetCompletionResult(
        change_set_id=change_set.change_set_id,
        active_path=active_path,
        completed_path=completed_path,
        report_path=report_path,
        completed_work_items=work_item_ids,
        completed_plan_paths=completed_plan_paths,
        run_id=effective_run_id,
    )


def _first_unchecked_checkbox(lines: list[str]) -> tuple[int, str] | None:
    for index, line in enumerate(lines, start=1):
        if re.match(r"^\s*-\s*\[\s\]", line):
            return index, line
    return None


def _load_execution_report(
    repo_root: Path,
    *,
    relative_plan_path: Path,
    run_id: str | None,
    work_item_id: str | None,
) -> Mapping[str, Any] | None:
    item_id = work_item_id or _work_item_id_from_plan_path(relative_plan_path)
    if not run_id or not item_id:
        return None
    path = Path(".harness/runs") / run_id / "work-items" / item_id / "execution-report.json"
    absolute = repo_root / path
    if not absolute.exists():
        return None
    try:
        report = json.loads(absolute.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise PlanCompletionBlocked(f"invalid execution report JSON: {path}: {exc}")
    if not isinstance(report, Mapping):
        raise PlanCompletionBlocked(f"execution report must be a JSON object: {path}")
    return report


def _validate_execution_report(
    repo_root: Path,
    report: Mapping[str, Any],
    *,
    relative_plan_path: Path,
    plan_text: str,
    run_id: str | None,
    work_item_id: str | None,
) -> None:
    expected_fingerprint = _plan_fingerprint(plan_text)
    if report.get("plan_fingerprint") != expected_fingerprint:
        raise PlanCompletionBlocked(
            "execution report fingerprint does not match active plan: "
            f"expected={expected_fingerprint} actual={report.get('plan_fingerprint', '-')}"
        )
    if str(report.get("plan_path", "")) != str(relative_plan_path):
        raise PlanCompletionBlocked(
            "execution report plan_path does not match active plan: "
            f"{report.get('plan_path', '-')}"
        )
    if work_item_id and report.get("work_item_id") not in (None, work_item_id):
        raise PlanCompletionBlocked(
            "execution report work_item_id does not match selected work item: "
            f"{report.get('work_item_id', '-')}"
        )
    if report.get("status") != "completed":
        raise PlanCompletionBlocked(
            f"execution report is not completed: status={report.get('status', '-')}"
        )

    verification = report.get("verification")
    if not isinstance(verification, list):
        raise PlanCompletionBlocked("execution report missing verification list")

    by_label: dict[str, Mapping[str, Any]] = {}
    for item in verification:
        if isinstance(item, Mapping) and isinstance(item.get("label"), str):
            by_label[str(item["label"])] = item

    evidence_paths: list[Path] = []
    for label in _REQUIRED_CANONICAL_RESULT_LABELS:
        item = by_label.get(label)
        if item is None:
            raise PlanCompletionBlocked(f"missing verification result: {label}")
        status = str(item.get("status", "")).strip().upper()
        if status != "PASS":
            raise PlanCompletionBlocked(
                f"verification result is not PASS: {label}={item.get('status', '-')}"
            )
        raw_evidence = item.get("evidence")
        if not isinstance(raw_evidence, list):
            raw_evidence_path = item.get("evidence_path")
            raw_evidence = [raw_evidence_path] if isinstance(raw_evidence_path, str) else []
        if not raw_evidence:
            raise PlanCompletionBlocked(
                f"missing evidence path for verification result: {label}"
            )
        for raw_path in raw_evidence:
            if not isinstance(raw_path, str):
                raise PlanCompletionBlocked(
                    f"invalid evidence path for verification result: {label}"
                )
            path = Path(raw_path)
            if path.parts[:2] != (".harness", "runs"):
                raise PlanCompletionBlocked(
                    f"evidence artifact must be under .harness/runs: {path}"
                )
            if run_id and path.parts[:3] != (".harness", "runs", run_id):
                raise PlanCompletionBlocked(
                    f"evidence artifact belongs to another run: {path}"
                )
            evidence_paths.append(path)

    for path in evidence_paths:
        absolute = repo_root / path
        if not absolute.exists():
            raise PlanCompletionBlocked(f"missing evidence artifact: {path}")


def _plan_fingerprint(text: str) -> str:
    return "sha256:" + hashlib.sha256(text.encode("utf-8")).hexdigest()


def _work_item_id_from_plan_path(path: Path) -> str | None:
    if len(path.parts) >= 5 and path.parts[:3] == ("docs", "plans", "active"):
        return path.parts[3]
    if len(path.parts) >= 5 and path.parts[:3] == ("docs", "plans", "completed"):
        return path.parts[3]
    return None


def _has_section(text: str, section_name: str) -> bool:
    return (
        re.search(rf"^##+\s+.*{re.escape(section_name)}.*$", text, re.MULTILINE)
        is not None
    )


def _section_body(text: str, section_name: str) -> str | None:
    match = re.search(
        rf"^##+\s+.*{re.escape(section_name)}.*$([\s\S]*?)(?=^##+\s+|\Z)",
        text,
        re.MULTILINE,
    )
    if match is None:
        return None
    return match.group(1)


def _result_entry(section: str, label: str) -> str | None:
    labels = "|".join(re.escape(item) for item in _REQUIRED_RESULT_LABELS)
    for alias in _RESULT_LABEL_ALIASES.get(label, (label,)):
        pattern = (
            rf"(?ms)^\s*-\s*{re.escape(alias)}\s*:\s*(.*?)"
            rf"(?=^\s*-\s*(?:{labels})\s*:|^##+\s+|\Z)"
        )
        match = re.search(pattern, section)
        if match is not None:
            return match.group(1).strip()
    return None


def _is_empty_result(entry: str) -> bool:
    return not entry or entry in {"-", "`-`", "none", "None", "없음"}


def _is_not_applicable(entry: str) -> bool:
    return bool(
        re.search(r"\b(?:n/a|not applicable)\b|해당\s*없음", entry, re.IGNORECASE)
    )


def _not_applicable_error(label: str, entry: str) -> str | None:
    if not _is_not_applicable(entry):
        return None
    if label == "Runtime server verification":
        if re.search(
            r"\b(?:because|reason|no runnable|no runtime|no server|no ui)\b|이유|사유",
            entry,
            re.IGNORECASE,
        ):
            return None
        return "runtime server verification is not applicable without a reason"
    if label == "Static analysis":
        if re.search(r"\bpolicy\b|정책", entry, re.IGNORECASE):
            return None
        return "static analysis is not applicable without plan policy"
    return f"{label} cannot be marked not applicable"


def _evidence_paths(entry: str, *, run_id: str | None) -> tuple[Path, ...]:
    raw_paths = re.findall(r"(?:`|\b)(\.harness/runs/[^\s`)]+)", entry)
    paths: list[Path] = []
    for raw_path in raw_paths:
        cleaned = raw_path.rstrip(".,;:")
        path = Path(cleaned)
        if run_id and path.parts[:3] != (".harness", "runs", run_id):
            continue
        paths.append(path)
    return tuple(dict.fromkeys(paths))


def _fallback_evidence_paths(
    repo_root: Path,
    *,
    work_item_id: str,
    label: str,
    run_id: str | None,
) -> tuple[Path, ...]:
    names_by_label = {
        "Build": ("build.txt",),
        "Tests": ("tests.txt",),
        "E2E 또는 maintenance verification": ("e2e.txt", "tests.txt"),
        "Test gate": ("test-gate.txt",),
        "Runtime server verification": ("runtime.txt",),
        "Static analysis": ("static-analysis.txt",),
    }
    names = names_by_label.get(label, ())
    if not names:
        return ()
    all_run_roots = tuple(
        sorted(
            (repo_root / ".harness/runs").glob("run-*"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
    )
    run_roots = (
        tuple(dict.fromkeys((repo_root / ".harness/runs" / run_id, *all_run_roots)))
        if run_id
        else all_run_roots
    )
    for run_root in run_roots:
        evidence_dir = (
            run_root
            / "work-items"
            / work_item_id
            / "steps"
            / "execute-work-item"
            / "evidence"
        )
        if not evidence_dir.is_dir():
            continue
        paths = tuple(
            path.relative_to(repo_root)
            for name in names
            if (path := evidence_dir / name).is_file()
        )
        if paths:
            return paths
    return ()


def _latest_run_id_for_change_set(repo_root: Path, change_set_id: str) -> str | None:
    runs_dir = repo_root / ".harness/runs"
    if not runs_dir.exists():
        return None

    candidates: list[tuple[float, str]] = []
    for state_path in runs_dir.glob("*/state.json"):
        if state_path.parent.name.startswith("changeset-state-"):
            continue
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        if data.get("change_set_id") == change_set_id:
            candidates.append((state_path.stat().st_mtime, state_path.parent.name))

    if not candidates:
        return None
    return sorted(candidates)[-1][1]


def _load_successful_run_report(
    repo_root: Path,
    run_id: str,
    work_item_ids: tuple[str, ...],
) -> tuple[Mapping[str, Any], Path]:
    report_path = Path(".harness/runs") / run_id / "report.json"
    absolute_report_path = repo_root / report_path
    if not absolute_report_path.exists():
        raise ChangeSetCompletionBlocked(f"latest run report does not exist: {report_path}")

    report = json.loads(absolute_report_path.read_text(encoding="utf-8"))
    if report.get("status") != "succeeded":
        raise ChangeSetCompletionBlocked(
            f"latest run did not succeed: run_id={run_id} status={report.get('status', '-') }"
        )

    failed_or_blocked = tuple(
        item_id
        for item_id in tuple(report.get("failed_use_cases", ()))
        + tuple(report.get("blocked_use_cases", ()))
        if item_id in work_item_ids
    )
    if failed_or_blocked:
        raise ChangeSetCompletionBlocked(
            "latest run report contains failed or blocked work items: "
            + ", ".join(failed_or_blocked)
        )

    work_item_reports = tuple(report.get("work_item_reports", ()))
    for item in work_item_reports:
        item_id = str(item.get("work_item_id", ""))
        if item_id in work_item_ids and item.get("status") != "succeeded":
            raise ChangeSetCompletionBlocked(
                "latest run report contains non-succeeded work item result: "
                f"{item_id}:{item.get('status', '-')}"
            )

    return report, report_path


def _write_completion_report(
    repo_root: Path,
    report_path: Path,
    *,
    change_set: ChangeSet,
    run_id: str,
    active_path: Path,
    completed_path: Path,
    completed_work_items: tuple[str, ...],
    completed_plan_paths: tuple[Path, ...],
    run_report_path: Path,
    run_report: Mapping[str, Any],
) -> None:
    path = repo_root / report_path
    path.parent.mkdir(parents=True, exist_ok=True)

    work_item_lines = [
        "| Work Item | Completed Plan |",
        "| --- | --- |",
        *[
            f"| `{item_id}` | `{plan_path}` |"
            for item_id, plan_path in zip(completed_work_items, completed_plan_paths)
        ],
    ]
    verification_result = run_report.get("status", "-")
    work_item_results = run_report.get("work_item_reports", ())
    verification_lines = [
        f"- Run report: `{run_report_path}`",
        f"- Run status: {verification_result}",
    ]
    for item in work_item_results:
        item_id = item.get("work_item_id", "-")
        status = item.get("status", "-")
        verification_goal = item.get("verification_goal_path", "-")
        verification_lines.append(
            f"- `{item_id}`: status={status}, verification_goal=`{verification_goal}`"
        )

    path.write_text(
        "\n".join(
            [
                f"# ChangeSet Completion Report {change_set.change_set_id}",
                "",
                f"- ChangeSet: `{change_set.change_set_id}`",
                f"- Run ID: `{run_id}`",
                "- Status: completed",
                f"- Active path: `{active_path}`",
                f"- Completed path: `{completed_path}`",
                "",
                "## Completed Work Items",
                *work_item_lines,
                "",
                "## Verification",
                *verification_lines,
                "",
            ]
        ),
        encoding="utf-8",
    )
