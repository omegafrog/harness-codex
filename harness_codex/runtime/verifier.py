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


class VerificationStatus(str, Enum):
    """Outcome categories for one use-case verification pass."""

    PASS = "PASS"
    IMPLEMENTATION_FAILURE = "IMPLEMENTATION_FAILURE"
    UNCLEAR_E2E_GOAL = "UNCLEAR_E2E_GOAL"
    DOCUMENT_DELTA_CONFLICT = "DOCUMENT_DELTA_CONFLICT"
    UPSTREAM_DESIGN_CONFLICT = "UPSTREAM_DESIGN_CONFLICT"
    ENVIRONMENT_BLOCKER = "ENVIRONMENT_BLOCKER"


@dataclass(frozen=True)
class UseCaseVerificationInput:
    """Inputs required to verify a single implemented use-case plan."""

    change_set_path: Path
    plan_path: Path
    e2e_goal_path: Path
    repository_settings_path: Path = Path(".codex/repository-settings.md")
    test_gate_path: Path = Path(".codex/test-gate.yaml")
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
