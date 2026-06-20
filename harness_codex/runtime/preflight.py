"""Deterministic workflow preflight checks."""

from __future__ import annotations

import hashlib
import json
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping


PREFLIGHT_SCHEMA_VERSION = 1

PLACEHOLDER_MARKERS = (
    "Application source paths",
    "Application test paths",
    "Replace broad application source and test path placeholders",
    "TBD",
    "To be derived",
    "Needs confirmation",
    "<UC-ID>",
    "<MAINT-ID>",
    "<WORK-ITEM-ID>",
)

TOOL_COMMAND_HINTS = {
    "docker": ("docker", "compose.yaml", "docker compose", "Dockerfile"),
    "semgrep": ("semgrep", ".semgrep"),
    "java": ("java", "gradle", "./gradlew"),
    "gradle": ("gradle", "./gradlew", "build.gradle", "settings.gradle"),
}


@dataclass(frozen=True)
class PreflightCheck:
    check_id: str
    status: str
    severity: str
    evidence: tuple[str, ...] = ()
    remediation: str = ""
    override_allowed: bool = False

    def as_dict(self) -> dict[str, object]:
        return {
            "check_id": self.check_id,
            "status": self.status,
            "severity": self.severity,
            "evidence": list(self.evidence),
            "remediation": self.remediation,
            "override_allowed": self.override_allowed,
        }


@dataclass(frozen=True)
class PreflightResult:
    status: str
    checks: tuple[PreflightCheck, ...]

    @property
    def blocking_checks(self) -> tuple[PreflightCheck, ...]:
        return tuple(
            check
            for check in self.checks
            if check.status == "fail" and check.severity == "blocking"
        )

    @property
    def passed(self) -> bool:
        return not self.blocking_checks

    def as_dict(self) -> dict[str, object]:
        return {
            "schema_version": PREFLIGHT_SCHEMA_VERSION,
            "status": self.status,
            "checks": [check.as_dict() for check in self.checks],
        }


def run_workflow_preflight(
    repo_root: Path,
    change_set_id: str,
    scopes: Iterable[object],
) -> PreflightResult:
    checks = [
        _affected_files_placeholder_check(repo_root, scopes),
        *_required_tool_checks(repo_root),
    ]
    status = "blocked" if any(
        check.status == "fail" and check.severity == "blocking" for check in checks
    ) else "passed"
    return PreflightResult(status=status, checks=tuple(checks))


def write_preflight_result(
    repo_root: Path,
    run_id: str,
    result: PreflightResult,
) -> Path:
    path = repo_root / ".harness/runs" / run_id / "preflight.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(result.as_dict(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


def preflight_cache_key(repo_root: Path, command: str) -> str:
    head = _git_head(repo_root)
    return hashlib.sha256(f"{head}\n{command.strip()}".encode("utf-8")).hexdigest()


def _affected_files_placeholder_check(
    repo_root: Path,
    scopes: Iterable[object],
) -> PreflightCheck:
    evidence: list[str] = []
    for path in _affected_files_paths(repo_root, scopes):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8")
        for marker in PLACEHOLDER_MARKERS:
            if marker in text:
                evidence.append(f"{path.relative_to(repo_root)} contains placeholder: {marker}")
                break
    if evidence:
        return PreflightCheck(
            check_id="affected-files-no-placeholders",
            status="fail",
            severity="blocking",
            evidence=tuple(evidence),
            remediation=(
                "Replace placeholder affected-file declarations with concrete paths "
                "or explicit glob patterns before running planner/executor stages. "
                "Resume with: harness implementation <CHG-ID> --apply"
            ),
            override_allowed=False,
        )
    return PreflightCheck(
        check_id="affected-files-no-placeholders",
        status="pass",
        severity="blocking",
        evidence=("affected-files documents contain no known placeholders",),
        remediation="",
        override_allowed=False,
    )


def _required_tool_checks(repo_root: Path) -> tuple[PreflightCheck, ...]:
    referenced_text = _tool_reference_text(repo_root)
    checks: list[PreflightCheck] = []
    for tool, hints in TOOL_COMMAND_HINTS.items():
        if not any(hint in referenced_text for hint in hints):
            continue
        binary = "gradle" if tool == "gradle" else tool
        if tool == "gradle" and (repo_root / "gradlew").is_file():
            checks.append(
                PreflightCheck(
                    check_id="required-tool-gradle",
                    status="pass",
                    severity="blocking",
                    evidence=("gradlew wrapper exists",),
                )
            )
            continue
        if shutil.which(binary):
            checks.append(
                PreflightCheck(
                    check_id=f"required-tool-{tool}",
                    status="pass",
                    severity="blocking",
                    evidence=(f"{binary} found on PATH",),
                )
            )
            continue
        checks.append(
            PreflightCheck(
                check_id=f"required-tool-{tool}",
                status="fail",
                severity="blocking",
                evidence=(f"{binary} not found on PATH",),
                remediation=(
                    f"Install `{binary}` or record an explicit approved verification "
                    "waiver before running runtime-dependent workflow stages. "
                    "Resume with: harness implementation <CHG-ID> --apply"
                ),
                override_allowed=True,
            )
        )
    return tuple(checks)


def _affected_files_paths(repo_root: Path, scopes: Iterable[object]) -> tuple[Path, ...]:
    paths: list[Path] = []
    for scope in scopes:
        work_item_id = str(getattr(scope, "display_id", "")).strip()
        if work_item_id:
            paths.append(repo_root / f"docs/use-cases/{work_item_id}/affected-files.md")
            paths.append(repo_root / f"docs/maintenance/{work_item_id}/affected-files.md")
        for raw_path in getattr(scope, "planner_inputs", ()):
            path = Path(raw_path)
            if path.name == "affected-files.md":
                paths.append(repo_root / path)
        for raw_path in getattr(scope, "executor_inputs", ()):
            path = Path(raw_path)
            if path.name == "affected-files.md":
                paths.append(repo_root / path)
    return tuple(dict.fromkeys(paths))


def _tool_reference_text(repo_root: Path) -> str:
    paths = [
        repo_root / ".codex/repository-settings.md",
        repo_root / ".codex/test-gate.yaml",
        repo_root / "compose.yaml",
        repo_root / "docker-compose.yaml",
        repo_root / "Dockerfile",
        repo_root / "build.gradle",
        repo_root / "build.gradle.kts",
        repo_root / "settings.gradle",
        repo_root / "settings.gradle.kts",
    ]
    chunks = []
    for path in paths:
        if path.is_file():
            chunks.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(chunks)


def _git_head(repo_root: Path) -> str:
    git_head = repo_root / ".git/HEAD"
    if not git_head.is_file():
        return "no-git-head"
    return git_head.read_text(encoding="utf-8").strip()
