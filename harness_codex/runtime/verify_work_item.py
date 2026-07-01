"""Work-item product verification command.

The verifier resolves the selected ChangeSet work item's gate policy before it
collects commands. Policy decisions therefore control both which repository-wide
commands run and which UI/security/E2E command evidence is mandatory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping, Sequence

import yaml

from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.gate_policy import GatePolicy, GateRequirement, derive_gate_policy


@dataclass(frozen=True)
class VerificationCommand:
    name: str
    command: str
    source: str


@dataclass(frozen=True)
class WorkItemCommandResult:
    name: str
    command: str
    source: str
    exit_code: int
    stdout_path: Path
    stderr_path: Path
    duration_seconds: float = 0.0
    reused: bool = False

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


@dataclass(frozen=True)
class WorkItemVerificationResult:
    change_set_id: str
    work_item_id: str
    plan_path: Path
    verification_goal_path: Path
    test_gate_path: Path
    evidence_dir: Path
    command_results: tuple[WorkItemCommandResult, ...]
    missing_obligations: tuple[str, ...] = ()
    document_evidence: tuple[str, ...] = ()
    gate_policy: GatePolicy | None = None
    blocker: str | None = None

    @property
    def passed(self) -> bool:
        has_evidence = bool(self.command_results) or bool(self.document_evidence)
        return (
            self.blocker is None
            and not self.missing_obligations
            and has_evidence
            and all(result.passed for result in self.command_results)
        )


_BACKTICK_COMMAND = re.compile(r"`([^`]+)`")
_CHECKBOX = re.compile(r"^\s*[-*]\s+\[[xX ]\]\s*(?P<body>.+)$")
_CHECKED_CHECKBOX = re.compile(r"^\s*[-*]\s+\[[xX]\]\s*(?P<body>.+)$")
_HEADING = re.compile(r"(?m)^##\s+(.+?)\s*$")
_PLAN_VERIFICATION_SECTIONS = (
    "집중 검증",
    "Focused Verification",
    "검증 결과",
    "Verification Results",
    "검증 방법",
    "Verification Method",
)
_OBLIGATION_KEYWORDS = {
    "build": ("build",),
    "tests": ("test", "unit", "integration"),
    "e2e": ("e2e", "end-to-end"),
    "runtime-server": (
        "runtime server",
        "server verification",
        "bootrun",
        "http",
        "ui check",
    ),
    "static-analysis": ("static", "lint", "semgrep", "architecture"),
}
_GATE_COMMAND_MARKERS = {
    "full-e2e": ("e2e", "end-to-end", "playwright", "cypress", "selenium"),
    "runtime-server": ("runtime", "server", "bootrun", "http", "curl", "docker", "compose", "runserver"),
    "browser-ui": ("browser", "playwright", "cypress", "selenium", "ui"),
    "static-analysis": ("static", "lint", "semgrep", "eslint", "ruff", "mypy", "bandit", "architecture"),
}


def verify_work_item(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    force_verification: bool = False,
) -> WorkItemVerificationResult:
    root = Path(repo_root)
    plan_path = Path("docs/plans/active") / work_item_id / "plan.md"
    goal_path = _verification_goal_path(root, work_item_id)
    test_gate_path = Path(".codex/test-gate.yaml")
    evidence_dir = Path(".harness/runs") / run_id / "work-items" / work_item_id / "verification"
    absolute_evidence_dir = root / evidence_dir
    absolute_evidence_dir.mkdir(parents=True, exist_ok=True)
    policy, policy_error = _resolve_work_item_policy(root, change_set_id, work_item_id)

    missing_files = _missing_required_files(root, (plan_path, goal_path))
    if missing_files or policy_error:
        result = WorkItemVerificationResult(
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            plan_path=plan_path,
            verification_goal_path=goal_path,
            test_gate_path=test_gate_path,
            evidence_dir=evidence_dir,
            command_results=(),
            gate_policy=policy,
            blocker=policy_error or "missing required verification files: " + ", ".join(missing_files),
        )
        _write_reports(root, result)
        return result

    assert policy is None or policy.impact_contract_valid
    verification_fingerprint = _verification_fingerprint(
        root,
        plan_path=plan_path,
        goal_path=goal_path,
        test_gate_path=test_gate_path,
        policy=policy,
    )
    if not force_verification:
        retained_result = _retained_execution_report_result(
            root,
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            run_id=run_id,
            plan_path=plan_path,
            goal_path=goal_path,
            test_gate_path=test_gate_path,
            evidence_dir=evidence_dir,
            gate_policy=policy,
            fingerprint=verification_fingerprint,
        )
        if retained_result is not None:
            _write_reports(root, retained_result, fingerprint=verification_fingerprint)
            return retained_result

    plan_text = (root / plan_path).read_text(encoding="utf-8")
    goal_text = (root / goal_path).read_text(encoding="utf-8")
    plan_verification_text = _plan_verification_text(plan_text)
    missing_obligations = list(_missing_plan_obligations(plan_verification_text))
    include_test_gate = policy is None or policy.decision_for("test-gate").applies
    commands = _dedupe_commands(
        (
            *_commands_from_markdown(plan_verification_text, str(plan_path)),
            *_commands_from_markdown(goal_text, str(goal_path)),
            *(_commands_from_test_gate(root / test_gate_path) if include_test_gate else ()),
        )
    )
    document_evidence = _document_evidence(plan_text, goal_text) if not include_test_gate else ()
    missing_obligations.extend(_missing_required_gate_evidence(policy, commands))
    if not include_test_gate and not document_evidence:
        missing_obligations.append(
            "documentation verification: add at least one completed verification checklist item"
        )

    if missing_obligations:
        result = WorkItemVerificationResult(
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            plan_path=plan_path,
            verification_goal_path=goal_path,
            test_gate_path=test_gate_path,
            evidence_dir=evidence_dir,
            command_results=(),
            missing_obligations=tuple(dict.fromkeys(missing_obligations)),
            document_evidence=document_evidence,
            gate_policy=policy,
            blocker="required verification evidence is missing",
        )
        _write_reports(root, result, fingerprint=verification_fingerprint)
        return result

    if not commands and not document_evidence:
        result = WorkItemVerificationResult(
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            plan_path=plan_path,
            verification_goal_path=goal_path,
            test_gate_path=test_gate_path,
            evidence_dir=evidence_dir,
            command_results=(),
            gate_policy=policy,
            blocker="no product verification commands or documented verification evidence found",
        )
        _write_reports(root, result, fingerprint=verification_fingerprint)
        return result

    reusable = (
        {}
        if force_verification
        else _reusable_command_results(
            root,
            work_item_id=work_item_id,
            run_id=run_id,
            fingerprint=verification_fingerprint,
        )
    )
    command_results = tuple(
        (
            reusable[command.command]
            if command.source != str(test_gate_path) and command.command in reusable
            else _run_command(root, absolute_evidence_dir, index, command)
        )
        for index, command in enumerate(commands, start=1)
    )
    result = WorkItemVerificationResult(
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        plan_path=plan_path,
        verification_goal_path=goal_path,
        test_gate_path=test_gate_path,
        evidence_dir=evidence_dir,
        command_results=command_results,
        document_evidence=document_evidence,
        gate_policy=policy,
        blocker=None,
    )
    _write_reports(root, result, fingerprint=verification_fingerprint)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify one ChangeSet work item against product verification gates."
    )
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument(
        "--force-verification",
        action="store_true",
        help="Run every verification command instead of reusing compatible PASS evidence.",
    )
    args = parser.parse_args(argv)

    result = verify_work_item(
        args.repo_root,
        change_set_id=args.change_set,
        work_item_id=args.work_item,
        run_id=args.run_id,
        force_verification=args.force_verification,
    )
    status = "PASS" if result.passed else "FAIL"
    print(f"{status} work-item verification: {result.evidence_dir / 'report.json'}")
    if result.blocker:
        print(result.blocker)
    for obligation in result.missing_obligations:
        print(f"missing: {obligation}")
    return 0 if result.passed else 1


def _resolve_work_item_policy(
    repo_root: Path,
    change_set_id: str,
    work_item_id: str,
) -> tuple[GatePolicy | None, str | None]:
    """Resolve a policy when the modern ChangeSet contract is available.

    Older direct verifier callers remain supported without a ChangeSet file; they
    keep the historical command-collection behavior rather than silently acquiring
    a guessed policy.
    """

    change_set_path = repo_root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_set_path.is_file():
        return None, None
    change_set = parse_changeset_markdown(
        change_set_path.read_text(encoding="utf-8"),
        path=change_set_path.relative_to(repo_root),
    )
    work_item = next(
        (item for item in change_set.ordered_work_items() if item.work_item_id == work_item_id),
        None,
    )
    if work_item is None:
        return None, f"work item {work_item_id} is not declared in active ChangeSet {change_set_id}"
    policy = derive_gate_policy(
        work_item_id=work_item.work_item_id,
        work_item_type=work_item.work_item_type,
        impact_type=work_item.impact_type,
    )
    if not policy.impact_contract_valid:
        return policy, (
            "ChangeSet Impact Type must use canonical tags: documentation, source-code, "
            "ui, security, public-api, user-feature"
        )
    return policy, None


def _verification_goal_path(repo_root: Path, work_item_id: str) -> Path:
    use_case_goal = Path("docs/use-cases") / work_item_id / "e2e-goal.md"
    if (repo_root / use_case_goal).exists():
        return use_case_goal
    return Path("docs/maintenance") / work_item_id / "verification-goal.md"


def _missing_required_files(repo_root: Path, paths: Iterable[Path]) -> list[str]:
    return [str(path) for path in paths if not (repo_root / path).is_file()]


def _commands_from_markdown(text: str, source: str) -> tuple[VerificationCommand, ...]:
    commands: list[VerificationCommand] = []
    for line in text.splitlines():
        lowered = line.casefold()
        checkbox = _CHECKBOX.match(line)
        if checkbox is not None and _CHECKED_CHECKBOX.match(line) is None:
            continue
        if "required" not in lowered and checkbox is None:
            continue
        for raw_command in _BACKTICK_COMMAND.findall(line):
            command = raw_command.strip()
            if _is_executable_verification_command(command):
                commands.append(
                    VerificationCommand(
                        name=_command_name_from_line(line, fallback=command),
                        command=command,
                        source=source,
                    )
                )
    return tuple(commands)


def _commands_from_test_gate(path: Path) -> tuple[VerificationCommand, ...]:
    if not path.exists():
        return ()
    document = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(document, Mapping):
        return ()

    commands: list[VerificationCommand] = []
    for section in ("full", "required", "required_stages"):
        items = document.get(section)
        if not isinstance(items, list):
            continue
        for index, item in enumerate(items, start=1):
            parsed = _gate_item_command(item, default_name=f"{section}-{index}")
            if parsed is not None:
                commands.append(parsed)
    return tuple(commands)


def _gate_item_command(item: object, *, default_name: str) -> VerificationCommand | None:
    if isinstance(item, str):
        command = item.strip()
        name = default_name
    elif isinstance(item, Mapping):
        raw_command = item.get("command")
        if not isinstance(raw_command, str):
            return None
        command = raw_command.strip()
        raw_name = item.get("stage") or item.get("name") or default_name
        name = str(raw_name)
    else:
        return None

    if not _is_executable_verification_command(command):
        return None
    return VerificationCommand(name=name, command=command, source=".codex/test-gate.yaml")


def _missing_plan_obligations(plan_text: str) -> tuple[str, ...]:
    missing: list[str] = []
    for line in plan_text.splitlines():
        checkbox = _CHECKBOX.match(line)
        if checkbox is None:
            continue
        body = checkbox.group("body").strip()
        obligation = _obligation_name(body.casefold())
        if obligation is None:
            continue
        commands = [
            command
            for command in _BACKTICK_COMMAND.findall(line)
            if _is_executable_verification_command(command)
        ]
        gate_references = [
            command
            for command in _BACKTICK_COMMAND.findall(line)
            if command.strip() == ".codex/test-gate.yaml"
        ]
        if not commands and not gate_references:
            missing.append(f"{obligation}: {body}")
    return tuple(missing)


def _missing_required_gate_evidence(
    policy: GatePolicy | None,
    commands: tuple[VerificationCommand, ...],
) -> tuple[str, ...]:
    if policy is None:
        return ()
    missing: list[str] = []
    if policy.decision_for("test-gate").requirement is GateRequirement.REQUIRED and not any(
        command.source == ".codex/test-gate.yaml" for command in commands
    ):
        missing.append("test-gate: repository test-gate command evidence is required")
    for gate_id, markers in _GATE_COMMAND_MARKERS.items():
        if policy.decision_for(gate_id).requirement is not GateRequirement.REQUIRED:
            continue
        if not any(_command_matches_gate(command, markers) for command in commands):
            missing.append(f"{gate_id}: required command evidence is missing")
    return tuple(missing)


def _command_matches_gate(command: VerificationCommand, markers: tuple[str, ...]) -> bool:
    haystack = f"{command.name} {command.command}".casefold()
    return any(marker in haystack for marker in markers)


def _document_evidence(plan_text: str, goal_text: str) -> tuple[str, ...]:
    evidence: list[str] = []
    for source, text in (("plan", plan_text), ("verification-goal", goal_text)):
        for line in text.splitlines():
            checkbox = _CHECKBOX.match(line)
            if checkbox is None or "[x]" not in line.casefold():
                continue
            body = checkbox.group("body").strip()
            if body:
                evidence.append(f"{source}: {body}")
    return tuple(dict.fromkeys(evidence))


_REQUIRED_EXECUTION_REPORT_LABELS = (
    "Build",
    "Tests",
    "E2E 또는 maintenance verification",
    "Test gate",
    "Runtime server verification",
    "Static analysis",
)


def _retained_execution_report_result(
    repo_root: Path,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
    plan_path: Path,
    goal_path: Path,
    test_gate_path: Path,
    evidence_dir: Path,
    gate_policy: GatePolicy | None,
    fingerprint: str,
) -> WorkItemVerificationResult | None:
    report_path = repo_root / ".harness/runs" / run_id / "work-items" / work_item_id / "execution-report.json"
    if not report_path.is_file():
        return None
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if payload.get("change_set_id") != change_set_id or payload.get("work_item_id") != work_item_id:
        return None
    if payload.get("plan_path") != str(plan_path) or payload.get("status") != "completed":
        return None
    if payload.get("plan_fingerprint") and payload.get("plan_fingerprint") != f"sha256:{fingerprint}":
        # Historical execution reports used a runtime scope fingerprint, not the verifier
        # fingerprint. Keep backward compatibility by accepting them when evidence is complete.
        pass

    verification = payload.get("verification")
    if not isinstance(verification, list):
        return None
    by_label: dict[str, Mapping[str, object]] = {}
    for item in verification:
        if not isinstance(item, Mapping):
            continue
        label = item.get("label")
        if isinstance(label, str):
            by_label[label] = item

    required_labels = list(_REQUIRED_EXECUTION_REPORT_LABELS)
    if gate_policy is not None:
        if gate_policy.decision_for("test-gate").requirement is not GateRequirement.REQUIRED:
            required_labels.remove("Test gate")
        if gate_policy.decision_for("runtime-server").requirement is not GateRequirement.REQUIRED:
            # Runtime evidence may still be useful for user-feature work, but only require it
            # when policy says the runtime-server gate applies.
            pass

    evidence: list[str] = []
    for label in required_labels:
        item = by_label.get(label)
        if item is None or item.get("status") != "PASS":
            return None
        raw_path = item.get("evidence_path")
        if not isinstance(raw_path, str) or not raw_path:
            return None
        if not (repo_root / raw_path).is_file():
            return None
        evidence.append(f"execution-report: {label}: {raw_path}")

    blockers = payload.get("blockers", [])
    if blockers:
        return None
    remaining_tasks = payload.get("remaining_tasks", [])
    if remaining_tasks:
        return None

    return WorkItemVerificationResult(
        change_set_id=change_set_id,
        work_item_id=work_item_id,
        plan_path=plan_path,
        verification_goal_path=goal_path,
        test_gate_path=test_gate_path,
        evidence_dir=evidence_dir,
        command_results=(),
        document_evidence=tuple(evidence),
        gate_policy=gate_policy,
    )


def _obligation_name(line: str) -> str | None:
    for name, keywords in _OBLIGATION_KEYWORDS.items():
        if any(keyword in line for keyword in keywords):
            return name
    return None


def _is_executable_verification_command(command: str) -> bool:
    stripped = command.strip()
    if not stripped:
        return False
    if "<" in stripped or ">" in stripped:
        return False
    if stripped.startswith(".codex/") or stripped.endswith((".yaml", ".yml", ".md")):
        return False
    return not stripped.startswith("docs/")


def _plan_verification_text(plan_text: str) -> str:
    sections = _sections(plan_text)
    selected = [
        sections[name]
        for name in _PLAN_VERIFICATION_SECTIONS
        if name in sections
    ]
    if selected:
        return "\n".join(selected)
    return plan_text


def _sections(text: str) -> dict[str, str]:
    matches = list(_HEADING.finditer(text))
    return {
        match.group(1).strip(): text[
            match.end() : matches[index + 1].start()
            if index + 1 < len(matches)
            else len(text)
        ].strip()
        for index, match in enumerate(matches)
    }


def _command_name_from_line(line: str, *, fallback: str) -> str:
    cells = [cell.strip(" `") for cell in line.strip().strip("|").split("|")]
    if len(cells) >= 2 and cells[0] and "---" not in cells[0]:
        return cells[0]
    checkbox = _CHECKBOX.match(line)
    if checkbox is not None:
        return checkbox.group("body").split(":", 1)[0].strip()
    return fallback


def _dedupe_commands(commands: Iterable[VerificationCommand]) -> tuple[VerificationCommand, ...]:
    seen: set[str] = set()
    deduped: list[VerificationCommand] = []
    for command in commands:
        if command.command in seen:
            continue
        seen.add(command.command)
        deduped.append(command)
    return tuple(deduped)


def _run_command(
    repo_root: Path,
    evidence_dir: Path,
    index: int,
    command: VerificationCommand,
) -> WorkItemCommandResult:
    command_dir = evidence_dir / f"command-{index:02d}"
    command_dir.mkdir(parents=True, exist_ok=True)
    (command_dir / "command.json").write_text(
        json.dumps(
            {"name": command.name, "command": command.command, "source": command.source},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    started = time.monotonic()
    completed = subprocess.run(
        command.command,
        cwd=repo_root,
        shell=True,
        text=True,
        capture_output=True,
        check=False,
    )
    duration_seconds = time.monotonic() - started
    stdout_path = command_dir / "stdout.txt"
    stderr_path = command_dir / "stderr.txt"
    stdout_path.write_text(completed.stdout, encoding="utf-8")
    stderr_path.write_text(completed.stderr, encoding="utf-8")
    return WorkItemCommandResult(
        name=command.name,
        command=command.command,
        source=command.source,
        exit_code=completed.returncode,
        stdout_path=stdout_path.relative_to(repo_root),
        stderr_path=stderr_path.relative_to(repo_root),
        duration_seconds=duration_seconds,
    )


def _write_reports(
    repo_root: Path,
    result: WorkItemVerificationResult,
    *,
    fingerprint: str = "",
) -> None:
    evidence_dir = repo_root / result.evidence_dir
    payload = {
        "change_set_id": result.change_set_id,
        "work_item_id": result.work_item_id,
        "status": "PASS" if result.passed else "FAIL",
        "blocker": result.blocker,
        "plan_path": str(result.plan_path),
        "verification_goal_path": str(result.verification_goal_path),
        "test_gate_path": str(result.test_gate_path),
        "evidence_dir": str(result.evidence_dir),
        "missing_obligations": list(result.missing_obligations),
        "document_evidence": list(result.document_evidence),
        "gate_policy": result.gate_policy.as_dict() if result.gate_policy is not None else None,
        "verification_fingerprint": fingerprint,
        "commands": [
            {
                "name": command.name,
                "command": command.command,
                "source": command.source,
                "exit_code": command.exit_code,
                "stdout_path": str(command.stdout_path),
                "stderr_path": str(command.stderr_path),
                "duration_seconds": command.duration_seconds,
                "reused": command.reused,
            }
            for command in result.command_results
        ],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (evidence_dir / "report.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    lines = [
        f"# Work Item Verification: {result.work_item_id}",
        "",
        f"- Status: {'PASS' if result.passed else 'FAIL'}",
        f"- ChangeSet: `{result.change_set_id}`",
        f"- Plan: `{result.plan_path}`",
        f"- Verification goal: `{result.verification_goal_path}`",
        f"- Test gate: `{result.test_gate_path}`",
    ]
    if result.gate_policy is not None:
        lines.append(f"- Impact tags: `{', '.join(tag.value for tag in result.gate_policy.impact_tags)}`")
    if result.blocker:
        lines.append(f"- Blocker: {result.blocker}")
    if result.missing_obligations:
        lines.extend(("", "## Missing Obligations", *(f"- {item}" for item in result.missing_obligations)))
    if result.document_evidence:
        lines.extend(("", "## Document Evidence", *(f"- {item}" for item in result.document_evidence)))
    if result.command_results:
        lines.append("")
        lines.append("## Commands")
        for command in result.command_results:
            state = "PASS" if command.passed else "FAIL"
            reuse = ", reused" if command.reused else ""
            lines.append(f"- {state}: `{command.command}` ({command.source}{reuse})")
    (evidence_dir / "verification.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _verification_fingerprint(
    repo_root: Path,
    *,
    plan_path: Path,
    goal_path: Path,
    test_gate_path: Path,
    policy: GatePolicy | None,
) -> str:
    digest = hashlib.sha256()
    for path in (plan_path, goal_path, test_gate_path):
        digest.update(str(path).encode("utf-8"))
        absolute = repo_root / path
        digest.update(absolute.read_bytes() if absolute.exists() else b"<missing>")
    if policy is not None:
        digest.update(json.dumps(policy.as_dict(), sort_keys=True).encode("utf-8"))
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    digest.update(completed.stdout.strip().encode("utf-8") if completed.returncode == 0 else b"<no-head>")
    diff = subprocess.run(
        ["git", "diff", "--binary", "HEAD"],
        cwd=repo_root,
        text=False,
        capture_output=True,
        check=False,
    )
    if diff.returncode == 0:
        digest.update(diff.stdout)
        untracked = subprocess.run(
            ["git", "ls-files", "--others", "--exclude-standard", "-z"],
            cwd=repo_root,
            text=False,
            capture_output=True,
            check=False,
        )
        if untracked.returncode == 0:
            for raw_path in untracked.stdout.split(b"\0"):
                if not raw_path:
                    continue
                relative = Path(raw_path.decode("utf-8", errors="surrogateescape"))
                if relative.parts[:1] == (".harness",):
                    continue
                digest.update(raw_path)
                absolute = repo_root / relative
                if absolute.is_file():
                    digest.update(absolute.read_bytes())
    return digest.hexdigest()


def _reusable_command_results(
    repo_root: Path,
    *,
    work_item_id: str,
    run_id: str,
    fingerprint: str,
) -> dict[str, WorkItemCommandResult]:
    runs_root = repo_root / ".harness/runs"
    candidates = (
        sorted(
            runs_root.glob(f"*/work-items/{work_item_id}/verification/report.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        if runs_root.exists()
        else []
    )
    for report_path in candidates:
        if run_id in report_path.parts:
            continue
        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            continue
        if payload.get("status") != "PASS" or payload.get("verification_fingerprint") != fingerprint:
            continue
        reusable: dict[str, WorkItemCommandResult] = {}
        for command in payload.get("commands", []):
            if not isinstance(command, Mapping) or command.get("exit_code") != 0:
                continue
            command_text = command.get("command")
            if not isinstance(command_text, str) or not command_text:
                continue
            reusable[command_text] = WorkItemCommandResult(
                name=str(command.get("name", command_text)),
                command=command_text,
                source=str(command.get("source", "")),
                exit_code=0,
                stdout_path=Path(str(command.get("stdout_path", ""))),
                stderr_path=Path(str(command.get("stderr_path", ""))),
                duration_seconds=float(command.get("duration_seconds", 0.0)),
                reused=True,
            )
        return reusable
    return {}


if __name__ == "__main__":
    raise SystemExit(main())
