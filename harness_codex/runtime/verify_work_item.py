"""Work-item product verification command.

The runtime uses this module as the ChangeSet work-item verification gate. It
reads the active plan, the E2E or maintenance verification goal, and the project
test gate, then records command evidence under `.harness/runs/<RUN-ID>/`.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping, Sequence

import yaml


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
    blocker: str | None = None

    @property
    def passed(self) -> bool:
        return (
            self.blocker is None
            and not self.missing_obligations
            and bool(self.command_results)
            and all(result.passed for result in self.command_results)
        )


_BACKTICK_COMMAND = re.compile(r"`([^`]+)`")
_CHECKBOX = re.compile(r"^\s*[-*]\s+\[[xX ]\]\s*(?P<body>.+)$")
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


def verify_work_item(
    repo_root: Path | str,
    *,
    change_set_id: str,
    work_item_id: str,
    run_id: str,
) -> WorkItemVerificationResult:
    root = Path(repo_root)
    plan_path = Path("docs/plans/active") / work_item_id / "plan.md"
    goal_path = _verification_goal_path(root, work_item_id)
    test_gate_path = Path(".codex/test-gate.yaml")
    evidence_dir = (
        Path(".harness/runs") / run_id / "work-items" / work_item_id / "verification"
    )
    absolute_evidence_dir = root / evidence_dir
    absolute_evidence_dir.mkdir(parents=True, exist_ok=True)

    missing_files = _missing_required_files(root, (plan_path, goal_path))
    if missing_files:
        result = WorkItemVerificationResult(
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            plan_path=plan_path,
            verification_goal_path=goal_path,
            test_gate_path=test_gate_path,
            evidence_dir=evidence_dir,
            command_results=(),
            blocker="missing required verification files: " + ", ".join(missing_files),
        )
        _write_reports(root, result)
        return result

    plan_text = (root / plan_path).read_text(encoding="utf-8")
    goal_text = (root / goal_path).read_text(encoding="utf-8")
    missing_obligations = _missing_plan_obligations(plan_text)
    commands = _dedupe_commands(
        (
            *_commands_from_markdown(plan_text, str(plan_path)),
            *_commands_from_markdown(goal_text, str(goal_path)),
            *_commands_from_test_gate(root / test_gate_path),
        )
    )

    if not commands:
        result = WorkItemVerificationResult(
            change_set_id=change_set_id,
            work_item_id=work_item_id,
            plan_path=plan_path,
            verification_goal_path=goal_path,
            test_gate_path=test_gate_path,
            evidence_dir=evidence_dir,
            command_results=(),
            missing_obligations=missing_obligations,
            blocker="no product verification commands found in plan, verification goal, or test gate",
        )
        _write_reports(root, result)
        return result

    command_results = tuple(
        _run_command(root, absolute_evidence_dir, index, command)
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
        missing_obligations=missing_obligations,
        blocker=(
            "plan verification obligations are missing executable command evidence"
            if missing_obligations
            else None
        ),
    )
    _write_reports(root, result)
    return result


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Verify one ChangeSet work item against product verification gates."
    )
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", required=True)
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)

    result = verify_work_item(
        args.repo_root,
        change_set_id=args.change_set,
        work_item_id=args.work_item,
        run_id=args.run_id,
    )
    status = "PASS" if result.passed else "FAIL"
    print(f"{status} work-item verification: {result.evidence_dir / 'report.json'}")
    if result.blocker:
        print(result.blocker)
    for obligation in result.missing_obligations:
        print(f"missing: {obligation}")
    return 0 if result.passed else 1


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
        lowered = line.lower()
        if "required" not in lowered and _CHECKBOX.match(line) is None:
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
    return VerificationCommand(
        name=name,
        command=command,
        source=".codex/test-gate.yaml",
    )


def _missing_plan_obligations(plan_text: str) -> tuple[str, ...]:
    missing: list[str] = []
    for line in plan_text.splitlines():
        checkbox = _CHECKBOX.match(line)
        if checkbox is None:
            continue
        body = checkbox.group("body").strip()
        lowered = body.lower()
        obligation = _obligation_name(lowered)
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


def _obligation_name(line: str) -> str | None:
    for name, keywords in _OBLIGATION_KEYWORDS.items():
        if any(keyword in line for keyword in keywords):
            return name
    return None


def _is_executable_verification_command(command: str) -> bool:
    stripped = command.strip()
    if not stripped:
        return False
    if stripped.startswith(".codex/") or stripped.endswith((".yaml", ".yml", ".md")):
        return False
    if stripped.startswith("docs/"):
        return False
    return True


def _command_name_from_line(line: str, *, fallback: str) -> str:
    cells = [cell.strip(" `") for cell in line.strip().strip("|").split("|")]
    if len(cells) >= 2 and cells[0] and "---" not in cells[0]:
        return cells[0]
    checkbox = _CHECKBOX.match(line)
    if checkbox is not None:
        return checkbox.group("body").split(":", 1)[0].strip()
    return fallback


def _dedupe_commands(
    commands: Iterable[VerificationCommand],
) -> tuple[VerificationCommand, ...]:
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
            {
                "name": command.name,
                "command": command.command,
                "source": command.source,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    completed = subprocess.run(
        command.command,
        cwd=repo_root,
        shell=True,
        text=True,
        capture_output=True,
        check=False,
    )
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
    )


def _write_reports(repo_root: Path, result: WorkItemVerificationResult) -> None:
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
        "commands": [
            {
                "name": command.name,
                "command": command.command,
                "source": command.source,
                "exit_code": command.exit_code,
                "stdout_path": str(command.stdout_path),
                "stderr_path": str(command.stderr_path),
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
    if result.blocker:
        lines.append(f"- Blocker: {result.blocker}")
    if result.missing_obligations:
        lines.append("")
        lines.append("## Missing Obligations")
        lines.extend(f"- {item}" for item in result.missing_obligations)
    if result.command_results:
        lines.append("")
        lines.append("## Commands")
        for command in result.command_results:
            state = "PASS" if command.passed else "FAIL"
            lines.append(f"- {state}: `{command.command}` ({command.source})")
    (evidence_dir / "verification.md").write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    raise SystemExit(main())
