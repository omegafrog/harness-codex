"""Deterministic workflow preflight checks.

This module owns both the scoped policy matrix and the compatibility behavior for
legacy callers that do not yet provide a selected work-item scope. Keeping that
rule here avoids import-time monkey-patching of private helpers.
"""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Iterable, Mapping

import yaml

from harness_codex.runtime.gate_policy import GatePolicy, GateRequirement, derive_gate_policy_for_scope

PREFLIGHT_SCHEMA_VERSION = 2

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
TOOL_GATE_IDS = {
    "docker": "runtime-server",
    "semgrep": "static-analysis",
    "java": "test-gate",
    "gradle": "test-gate",
}


@dataclass(frozen=True)
class PreflightCheck:
    check_id: str
    status: str
    severity: str
    evidence: tuple[str, ...] = ()
    remediation: str = ""
    override_allowed: bool = False
    gate_id: str = ""
    phase: str = "deterministic-preflight"

    def as_dict(self) -> dict[str, object]:
        return {
            "check_id": self.check_id,
            "status": self.status,
            "severity": self.severity,
            "evidence": list(self.evidence),
            "remediation": self.remediation,
            "override_allowed": self.override_allowed,
            "gate_id": self.gate_id,
            "phase": self.phase,
        }


@dataclass(frozen=True)
class PreflightResult:
    status: str
    checks: tuple[PreflightCheck, ...]
    gate_policies: tuple[GatePolicy, ...] = ()

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
            "gate_policies": [policy.as_dict() for policy in self.gate_policies],
        }


def run_workflow_preflight(
    repo_root: Path,
    change_set_id: str,
    scopes: Iterable[object],
) -> PreflightResult:
    """Run deterministic checks relevant to the selected work-item scope.

    Scope contracts and placeholder resolution stay fail-closed. Environment and
    expensive command checks use the work-item policy: required checks block,
    conditional checks warn with a waiver path, and skipped checks are recorded.
    Legacy callers without a scope remain strict, while non-Docker environment
    failures retain their historical explicit-waiver path.
    """

    materialized_scopes = tuple(scopes)
    policies = tuple(
        derive_gate_policy_for_scope(repo_root, scope)
        for scope in materialized_scopes
    )
    checks = [
        *_required_tool_checks(repo_root, policies),
        *_baseline_command_checks(repo_root, policies),
    ]
    status = "blocked" if any(
        check.status == "fail" and check.severity == "blocking" for check in checks
    ) else "passed"
    return PreflightResult(status=status, checks=tuple(checks), gate_policies=policies)


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


def _baseline_command_checks(
    repo_root: Path,
    policies: tuple[GatePolicy, ...],
) -> tuple[PreflightCheck, ...]:
    commands = _baseline_commands(repo_root)
    if not commands:
        return ()
    requirement = _gate_requirement(policies, "test-gate")
    if requirement is GateRequirement.SKIPPED:
        return tuple(
            _skipped_gate_check(
                check_id=f"baseline-command:{command}",
                gate_id="test-gate",
                reason="The selected work-item policy does not require an application test gate.",
            )
            for command in commands
        )
    severity = "blocking" if requirement is GateRequirement.REQUIRED else "warning"
    return tuple(
        _baseline_command_check(repo_root, command, severity=severity, requirement=requirement)
        for command in commands
    )


def _baseline_command_check(
    repo_root: Path,
    command: str,
    *,
    severity: str,
    requirement: GateRequirement,
) -> PreflightCheck:
    cache_key = preflight_cache_key(repo_root, command)
    cache_path = repo_root / ".harness/preflight-cache" / f"{cache_key}.json"
    if cache_path.is_file():
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        passed = bool(cached.get("passed"))
        status = "pass" if passed else "fail"
        evidence = (
            f"cached baseline command result: command={command} "
            f"exit_code={cached.get('exit_code')} cache_key={cache_key}",
        )
        return PreflightCheck(
            check_id=f"baseline-command:{command}",
            status=status,
            severity=severity,
            evidence=evidence,
            remediation=_baseline_remediation(severity, command) if not passed else "",
            override_allowed=not passed and requirement is not GateRequirement.REQUIRED,
            gate_id="test-gate",
            phase="implementation-preflight",
        )

    completed = subprocess.run(
        command,
        cwd=repo_root,
        shell=True,
        text=True,
        capture_output=True,
        check=False,
    )
    evidence_text = (completed.stderr or completed.stdout).strip()
    if len(evidence_text) > 500:
        evidence_text = evidence_text[:497].rstrip() + "..."
    record = {
        "command": command,
        "cache_key": cache_key,
        "exit_code": completed.returncode,
        "passed": completed.returncode == 0,
        "evidence": evidence_text or f"exit_code={completed.returncode}",
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache_path.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    if completed.returncode == 0:
        return PreflightCheck(
            check_id=f"baseline-command:{command}",
            status="pass",
            severity=severity,
            evidence=(f"baseline command passed: command={command} cache_key={cache_key}",),
            gate_id="test-gate",
            phase="implementation-preflight",
        )
    failure_type = (
        "environment blocker"
        if completed.returncode == 127 or "not found" in record["evidence"].lower()
        else "baseline failure"
    )
    return PreflightCheck(
        check_id=f"baseline-command:{command}",
        status="fail",
        severity=severity,
        evidence=(
            f"{failure_type}: command={command} exit_code={completed.returncode} "
            f"cache_key={cache_key} evidence={record['evidence']}",
        ),
        remediation=_baseline_remediation(severity, command),
        override_allowed=requirement is not GateRequirement.REQUIRED,
        gate_id="test-gate",
        phase="implementation-preflight",
    )


def _baseline_remediation(severity: str, command: str) -> str:
    if severity == "blocking":
        return (
            f"Fix the required baseline command `{command}` before execution, or revise "
            "the work-item verification goal so the applied policy is correct."
        )
    return (
        f"Record why `{command}` is not applicable or approve a verification waiver "
        "before final completion."
    )


def _required_tool_checks(
    repo_root: Path,
    policies: tuple[GatePolicy, ...],
) -> tuple[PreflightCheck, ...]:
    referenced_text = _tool_reference_text(repo_root)
    checks: list[PreflightCheck] = []
    for tool, hints in TOOL_COMMAND_HINTS.items():
        if not any(hint in referenced_text for hint in hints):
            continue
        gate_id = TOOL_GATE_IDS[tool]
        requirement = _gate_requirement(policies, gate_id)
        if requirement is GateRequirement.SKIPPED:
            checks.append(
                _skipped_gate_check(
                    check_id=f"required-tool-{tool}",
                    gate_id=gate_id,
                    reason="The selected work-item policy marks this environment-dependent gate as not applicable.",
                )
            )
            continue
        binary = "gradle" if tool == "gradle" else tool
        severity = "blocking" if requirement is GateRequirement.REQUIRED else "warning"
        if tool == "gradle" and (repo_root / "gradlew").is_file():
            checks.append(
                PreflightCheck(
                    check_id="required-tool-gradle",
                    status="pass",
                    severity=severity,
                    evidence=("gradlew wrapper exists",),
                    gate_id=gate_id,
                    phase="implementation-preflight",
                )
            )
            continue
        if shutil.which(binary):
            if tool == "docker":
                checks.append(_docker_daemon_check(gate_id=gate_id))
                continue
            checks.append(
                PreflightCheck(
                    check_id=f"required-tool-{tool}",
                    status="pass",
                    severity=severity,
                    evidence=(f"{binary} found on PATH",),
                    gate_id=gate_id,
                    phase="implementation-preflight",
                )
            )
            continue
        checks.append(
            PreflightCheck(
                check_id=f"required-tool-{tool}",
                status="fail",
                severity=severity,
                evidence=(f"{binary} not found on PATH",),
                remediation=_tool_remediation(tool, binary),
                override_allowed=False if tool == "docker" else requirement is not GateRequirement.REQUIRED,
                gate_id=gate_id,
                phase="implementation-preflight",
            )
        )
    return _apply_legacy_unscoped_tool_waivers(tuple(checks), policies)


def _apply_legacy_unscoped_tool_waivers(
    checks: tuple[PreflightCheck, ...],
    policies: tuple[GatePolicy, ...],
) -> tuple[PreflightCheck, ...]:
    """Preserve explicit waivers for pre-scope callers without weakening Docker.

    Empty policy input means a legacy invocation cannot prove a gate irrelevant.
    The checks therefore remain required; however, historical callers were allowed
    to record a waiver for a non-Docker missing tool. Docker availability remains
    an operator-owned hard blocker because the runtime cannot remediate a stopped
    or unreachable daemon.
    """

    if policies:
        return checks
    return tuple(
        replace(check, override_allowed=True)
        if (
            check.status == "fail"
            and check.severity == "blocking"
            and check.check_id != "required-tool-docker"
        )
        else check
        for check in checks
    )


def _tool_remediation(tool: str, binary: str) -> str:
    if tool == "docker":
        return (
            "Install Docker and start Docker Desktop or the Docker daemon, then resume with: "
            "harness implementation <CHG-ID> --apply"
        )
    return (
        f"Install `{binary}` or record an approved waiver when the gate is conditional. "
        "Resume with: harness implementation <CHG-ID> --apply"
    )


def _docker_daemon_check(*, gate_id: str) -> PreflightCheck:
    try:
        completed = subprocess.run(
            ("docker", "info"),
            text=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            check=False,
            timeout=5,
        )
    except subprocess.TimeoutExpired:
        return PreflightCheck(
            check_id="required-tool-docker",
            status="fail",
            severity="blocking",
            evidence=("docker CLI found, but `docker info` timed out after 5 seconds",),
            remediation=(
                "Start Docker Desktop or the Docker daemon, then resume with: "
                "harness implementation <CHG-ID> --apply"
            ),
            override_allowed=False,
            gate_id=gate_id,
            phase="implementation-preflight",
        )
    if completed.returncode == 0:
        return PreflightCheck(
            check_id="required-tool-docker",
            status="pass",
            severity="blocking",
            evidence=("docker CLI found and Docker daemon is reachable",),
            gate_id=gate_id,
            phase="implementation-preflight",
        )
    detail = (completed.stderr or "").strip()
    if len(detail) > 500:
        detail = detail[:497].rstrip() + "..."
    return PreflightCheck(
        check_id="required-tool-docker",
        status="fail",
        severity="blocking",
        evidence=(f"docker CLI found, but Docker daemon is not reachable: {detail}",),
        remediation=(
            "Start Docker Desktop or the Docker daemon, then resume with: "
            "harness implementation <CHG-ID> --apply"
        ),
        override_allowed=False,
        gate_id=gate_id,
        phase="implementation-preflight",
    )


def _skipped_gate_check(*, check_id: str, gate_id: str, reason: str) -> PreflightCheck:
    return PreflightCheck(
        check_id=check_id,
        status="skipped",
        severity="info",
        evidence=(reason,),
        override_allowed=False,
        gate_id=gate_id,
        phase="implementation-preflight",
    )


def _gate_requirement(policies: tuple[GatePolicy, ...], gate_id: str) -> GateRequirement:
    """Return the strict legacy default when no work-item scope is available."""

    if not policies:
        return GateRequirement.REQUIRED
    requirements = {policy.decision_for(gate_id).requirement for policy in policies}
    if GateRequirement.REQUIRED in requirements:
        return GateRequirement.REQUIRED
    if GateRequirement.CONDITIONAL in requirements:
        return GateRequirement.CONDITIONAL
    if GateRequirement.OPTIONAL in requirements:
        return GateRequirement.OPTIONAL
    return GateRequirement.SKIPPED


def _baseline_commands(repo_root: Path) -> tuple[str, ...]:
    gate_path = repo_root / ".codex/test-gate.yaml"
    if not gate_path.is_file():
        return ()
    document = yaml.safe_load(gate_path.read_text(encoding="utf-8")) or {}
    commands: list[str] = []
    if isinstance(document, Mapping):
        for key in ("baseline", "required", "required_stages"):
            commands.extend(_commands_from_gate_items(document.get(key)))
    return tuple(dict.fromkeys(commands))


def _commands_from_gate_items(items: object) -> tuple[str, ...]:
    commands: list[str] = []
    if isinstance(items, str):
        candidate = items.strip()
        if _is_executable_command(candidate):
            commands.append(candidate)
    elif isinstance(items, Mapping):
        raw_command = items.get("command")
        if isinstance(raw_command, str) and _is_executable_command(raw_command):
            commands.append(raw_command.strip())
    elif isinstance(items, list):
        for item in items:
            commands.extend(_commands_from_gate_items(item))
    return tuple(commands)


def _is_executable_command(command: str) -> bool:
    stripped = command.strip()
    if not stripped:
        return False
    if stripped.startswith(".codex/") or stripped.endswith((".yaml", ".yml", ".md")):
        return False
    return not stripped.startswith("docs/")


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
    completed = subprocess.run(
        ("git", "rev-parse", "HEAD"),
        cwd=repo_root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if completed.returncode == 0 and completed.stdout.strip():
        return completed.stdout.strip()
    git_head = repo_root / ".git/HEAD"
    if not git_head.is_file():
        return "no-git-head"
    return git_head.read_text(encoding="utf-8").strip()
