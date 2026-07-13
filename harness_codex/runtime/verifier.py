"""Use-case scoped verification contract.

This module defines the data passed between a use-case executor loop and a
verifier. It executes only commands declared for that use case or maintenance
slice; it does not read repository-global verification configuration.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Mapping
import subprocess


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
class VerificationStageCheck:
    """One command result required by the scoped verification contract."""

    stage: str
    passed: bool
    evidence: str = ""


@dataclass(frozen=True)
class UseCaseVerificationResult:
    """Structured verifier result for the orchestrator loop."""

    status: VerificationStatus
    command_checks: tuple[CommandCheck, ...] = ()
    verification_checks: tuple[VerificationStageCheck, ...] = ()
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
    """Run declared verification commands for one use-case or maintenance plan."""

    def __init__(self, repo_root: Path | str) -> None:
        self.repo_root = Path(repo_root)

    def verify(
        self,
        verification_input: UseCaseVerificationInput,
    ) -> UseCaseVerificationResult:
        commands = self._commands(verification_input)
        command_checks = tuple(self._run_command(command) for command in commands)
        verification_checks = tuple(
            VerificationStageCheck(
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
                verification_checks=verification_checks,
            )

        if any("not found" in check.evidence.lower() for check in command_checks):
            return UseCaseVerificationResult(
                status=VerificationStatus.ENVIRONMENT_BLOCKER,
                command_checks=command_checks,
                verification_checks=verification_checks,
                blocker="verification command could not run in this environment",
            )

        return UseCaseVerificationResult(
            status=VerificationStatus.IMPLEMENTATION_FAILURE,
            command_checks=command_checks,
            verification_checks=verification_checks,
            blocker="one or more required verification commands failed",
        )

    def _commands(
        self,
        verification_input: UseCaseVerificationInput,
    ) -> tuple[str, ...]:
        return verification_input.required_commands

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
