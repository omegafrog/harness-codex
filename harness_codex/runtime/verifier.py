"""Use-case scoped verification contract.

This module defines the data passed between a use-case executor loop and a
verifier/test-gate implementation. It does not run Gradle, Playwright, or shell
commands directly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Mapping
import subprocess

import yaml


class VerificationStatus(str, Enum):
    """Outcome categories for one use-case verification pass."""

    PASS = "PASS"
    IMPLEMENTATION_FAILURE = "IMPLEMENTATION_FAILURE"
    UNCLEAR_E2E_GOAL = "UNCLEAR_E2E_GOAL"
    DOCUMENT_DELTA_CONFLICT = "DOCUMENT_DELTA_CONFLICT"
    UPSTREAM_DESIGN_CONFLICT = "UPSTREAM_DESIGN_CONFLICT"
    ENVIRONMENT_BLOCKER = "ENVIRONMENT_BLOCKER"


class VerificationTier(str, Enum):
    """Verification breadth for iterative vs final checks."""

    QUICK = "quick"
    FULL = "full"


@dataclass(frozen=True)
class UseCaseVerificationInput:
    """Inputs required to verify a single implemented use-case plan."""

    change_set_path: Path
    plan_path: Path
    e2e_goal_path: Path
    repository_settings_path: Path = Path(".codex/repository-settings.md")
    test_gate_path: Path = Path(".codex/test-gate.yaml")
    tier: VerificationTier = VerificationTier.FULL
    required_commands: tuple[str, ...] = (
        "./gradlew test",
        "./gradlew e2eTest",
    )


@dataclass(frozen=True)
class CommandCheck:
    """Recorded result for one build, test, e2e, or static-analysis command."""

    name: str
    command: str
    passed: bool
    evidence: str = ""


@dataclass(frozen=True)
class RequiredStageCheck:
    """Required stage result read from `.codex/test-gate.yaml`."""

    stage: str
    passed: bool
    evidence: str = ""


@dataclass(frozen=True)
class UseCaseVerificationResult:
    """Structured verifier result for the orchestrator loop."""

    status: VerificationStatus
    command_checks: tuple[CommandCheck, ...] = ()
    test_gate_checks: tuple[RequiredStageCheck, ...] = ()
    blocker: str | None = None
    metadata: Mapping[str, object] = field(default_factory=dict)

    @property
    def passed(self) -> bool:
        """Whether all required use-case verification gates passed."""

        return self.status == VerificationStatus.PASS

    @property
    def resumable_by_executor(self) -> bool:
        """Whether the executor loop may add remediation and retry."""

        return self.status == VerificationStatus.IMPLEMENTATION_FAILURE


class UseCaseVerifier:
    """Run repository test gates for one use-case or maintenance plan."""

    def __init__(self, repo_root: Path | str) -> None:
        self.repo_root = Path(repo_root)

    def verify(
        self,
        verification_input: UseCaseVerificationInput,
    ) -> UseCaseVerificationResult:
        commands = self._commands(verification_input)
        command_checks = tuple(self._run_command(command) for command in commands)
        test_gate_checks = tuple(
            RequiredStageCheck(
                stage=check.name,
                passed=check.passed,
                evidence=check.evidence,
            )
            for check in command_checks
        )

        if all(check.passed for check in command_checks):
            return UseCaseVerificationResult(
                status=VerificationStatus.PASS,
                command_checks=command_checks,
                test_gate_checks=test_gate_checks,
            )

        if any("not found" in check.evidence.lower() for check in command_checks):
            return UseCaseVerificationResult(
                status=VerificationStatus.ENVIRONMENT_BLOCKER,
                command_checks=command_checks,
                test_gate_checks=test_gate_checks,
                blocker="verification command could not run in this environment",
            )

        return UseCaseVerificationResult(
            status=VerificationStatus.IMPLEMENTATION_FAILURE,
            command_checks=command_checks,
            test_gate_checks=test_gate_checks,
            blocker="one or more required verification commands failed",
        )

    def _commands(
        self,
        verification_input: UseCaseVerificationInput,
    ) -> tuple[str, ...]:
        gate_path = self.repo_root / verification_input.test_gate_path
        if not gate_path.exists():
            return verification_input.required_commands

        document = yaml.safe_load(gate_path.read_text(encoding="utf-8")) or {}
        tier_commands = _commands_from_gate_items(document.get(verification_input.tier.value))
        if tier_commands:
            return tier_commands

        required = document.get("required") or document.get("required_stages") or []
        if verification_input.tier == VerificationTier.QUICK:
            quick_required = [
                item
                for item in required
                if isinstance(item, Mapping) and item.get("tier") == VerificationTier.QUICK.value
            ]
            quick_commands = _commands_from_gate_items(quick_required)
            if quick_commands:
                return quick_commands

        commands = _commands_from_gate_items(required)
        return commands or verification_input.required_commands

    def _run_command(self, command: str) -> CommandCheck:
        completed = subprocess.run(
            command,
            cwd=self.repo_root,
            shell=True,
            text=True,
            capture_output=True,
            check=False,
        )
        evidence = (completed.stderr or completed.stdout).strip()
        return CommandCheck(
            name=command,
            command=command,
            passed=completed.returncode == 0,
            evidence=evidence or f"exit_code={completed.returncode}",
        )


def _commands_from_gate_items(items: object) -> tuple[str, ...]:
    if not isinstance(items, list):
        return ()

    commands: list[str] = []
    for item in items:
        if isinstance(item, str):
            commands.append(item)
        elif isinstance(item, Mapping) and isinstance(item.get("command"), str):
            commands.append(item["command"])
    return tuple(commands)
