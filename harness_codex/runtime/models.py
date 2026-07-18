"""Generic runtime data models.

The module contains reusable execution and observation types only.  Concrete
workflow graphs, stage order, agent/skill selection, commands, and repository
layout are caller-owned declarations and must not be instantiated here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping


class RunMode(str, Enum):
    """How much side effect a caller authorizes."""

    PLAN = "plan"
    PREVIEW = "preview"
    APPLY = "apply"


class StepKind(str, Enum):
    """Generic adapter categories available to caller-declared workflows."""

    AGENT = "agent"
    SHELL = "shell"
    VALIDATOR = "validator"
    GIT = "git"
    DECISION = "decision"
    RECORD = "record"


class StepStatus(str, Enum):
    """Observed lifecycle state for a declared action."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


class RunStatus(str, Enum):
    """Observed lifecycle state for a run."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


class FailureKind(str, Enum):
    """Legacy observation labels retained during the compatibility window."""

    IMPLEMENTATION = "implementation"
    UPSTREAM_DESIGN = "upstream_design"
    ENVIRONMENT_BLOCKER = "environment_blocker"
    UNCLEAR_E2E_GOAL = "unclear_e2e_goal"
    DOCUMENT_DELTA_CONFLICT = "document_delta_conflict"
    SCOPE_CONFLICT = "scope_conflict"
    PLAN_REVIEW_REJECTED = "plan_review_rejected"
    VERIFICATION_GOAL_UNCLEAR = "verification_goal_unclear"
    UNKNOWN = "unknown"


class ContractValidationStatus(str, Enum):
    PASS = "pass"
    FAIL = "fail"


class ContractValidationSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    BLOCKING = "blocking"


@dataclass(frozen=True)
class ContractValidationResult:
    """Observed result for a caller-selected contract."""

    contract_id: str
    from_path: Path
    to_path: Path
    status: ContractValidationStatus
    severity: ContractValidationSeverity
    blocker: str = ""
    evidence: tuple[str, ...] = ()


@dataclass(frozen=True)
class StepDependency:
    """Generic prerequisite and allowed observed outcomes."""

    step_id: str
    allowed_outcomes: tuple[str, ...] = ("succeeded",)

    def __post_init__(self) -> None:
        if not self.step_id.strip():
            raise ValueError("dependency step_id must be non-empty")
        allowed = tuple(str(outcome).strip().lower() for outcome in self.allowed_outcomes)
        if not allowed or any(outcome not in {status.value for status in StepStatus} for outcome in allowed):
            raise ValueError("dependency outcomes must be valid StepStatus values")
        object.__setattr__(self, "allowed_outcomes", tuple(dict.fromkeys(allowed)))


@dataclass(frozen=True)
class Step:
    """A caller-declared action; the runtime assigns no meaning to its identity."""

    id: str
    kind: StepKind
    name: str
    needs: tuple[StepDependency | str, ...] = ()
    agent_id: str | None = None
    skill_id: str | None = None
    command: str | None = None
    inputs: tuple[Path, ...] = ()
    outputs: tuple[Path, ...] = ()
    timeout_sec: int | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        normalized = tuple(
            item if isinstance(item, StepDependency) else StepDependency(str(item))
            for item in self.needs
        )
        object.__setattr__(self, "needs", normalized)


@dataclass(frozen=True)
class Workflow:
    """A caller-provided action graph with no runtime-owned default instance."""

    name: str
    mode: RunMode
    steps: tuple[Step, ...]
    description: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)
    source_path: Path | None = None
    source_sha256: str = ""

    def step_ids(self) -> tuple[str, ...]:
        return tuple(step.id for step in self.steps)

    def step_by_id(self, step_id: str) -> Step:
        for step in self.steps:
            if step.id == step_id:
                return step
        raise KeyError(f"Unknown step id: {step_id}")


@dataclass(frozen=True)
class RunContext:
    """Caller-provided resource roots and opaque run metadata."""

    run_id: str
    workflow_name: str
    mode: RunMode
    repo_root: Path
    workdir: Path
    run_dir: Path
    active_plan_path: Path | None = None
    architecture_path: Path | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class StepResult:
    """Facts observed from one declared action."""

    step_id: str
    status: StepStatus
    exit_code: int | None = None
    output_path: Path | None = None
    error: str | None = None
    failure_kind: FailureKind | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @property
    def successful(self) -> bool:
        return self.status == StepStatus.SUCCEEDED


@dataclass(frozen=True)
class RunResult:
    """Facts observed from a caller-declared run."""

    run_id: str
    status: RunStatus
    step_results: tuple[StepResult, ...]
    mode: RunMode | None = None
    failed_step_id: str | None = None
    failure_kind: FailureKind | None = None
    blocker: str | None = None
    retry_count: int = 0
    metadata: Mapping[str, Any] = field(default_factory=dict)
