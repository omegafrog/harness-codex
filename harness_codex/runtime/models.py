"""Runtime data model for harness-codex.

This module models the current harness execution flow as structured data.

It does not call Codex, shell, git, or test tools directly. Later runtime work can
build RunnerEngine, workflow YAML, policy checks, state persistence, and resume
support on top of these objects.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping


class RunMode(str, Enum):
    """How much side effect the runtime may perform."""

    PLAN = "plan"
    PREVIEW = "preview"
    APPLY = "apply"


class StepKind(str, Enum):
    """Runtime step categories.

    The current harness-plan-executor flow is not just "agent + shell".

    It also:
    - records plan/verification evidence,
    - classifies verification failures,
    - decides whether to remediate, block, or complete the plan.

    So this first model includes `decision` and `record` in addition to the
    obvious execution step kinds.
    """

    AGENT = "agent"
    SHELL = "shell"
    VALIDATOR = "validator"
    GIT = "git"
    DECISION = "decision"
    RECORD = "record"


class StepStatus(str, Enum):
    """Lifecycle state for a single step."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    SKIPPED = "skipped"
    BLOCKED = "blocked"


class RunStatus(str, Enum):
    """Lifecycle state for a whole run."""

    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    BLOCKED = "blocked"
    CANCELLED = "cancelled"


class FailureKind(str, Enum):
    """Failure classification used by the current plan executor loop."""

    IMPLEMENTATION = "implementation"
    UPSTREAM_DESIGN = "upstream_design"
    ENVIRONMENT_BLOCKER = "environment_blocker"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Step:
    """A side-effect-free description of one runtime action."""

    id: str
    kind: StepKind
    name: str
    needs: tuple[str, ...] = ()
    agent_id: str | None = None
    command: str | None = None
    inputs: tuple[Path, ...] = ()
    outputs: tuple[Path, ...] = ()
    timeout_sec: int | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Workflow:
    """A reusable ordered graph of harness runtime steps."""

    name: str
    mode: RunMode
    steps: tuple[Step, ...]
    description: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def step_ids(self) -> tuple[str, ...]:
        """Return step IDs in declared order."""

        return tuple(step.id for step in self.steps)

    def step_by_id(self, step_id: str) -> Step:
        """Return a step by ID.

        Raises:
            KeyError: if the workflow does not contain the requested step.
        """

        for step in self.steps:
            if step.id == step_id:
                return step

        raise KeyError(f"Unknown step id: {step_id}")


@dataclass(frozen=True)
class RunContext:
    """Context shared by adapters during one run."""

    run_id: str
    workflow_name: str
    mode: RunMode
    repo_root: Path
    workdir: Path
    run_dir: Path
    active_plan_path: Path = Path("docs/plans/active/plan.md")
    architecture_path: Path = Path("ARCHITECTURE.md")


@dataclass(frozen=True)
class StepResult:
    """Structured result for one executed step."""

    step_id: str
    status: StepStatus
    exit_code: int | None = None
    output_path: Path | None = None
    error: str | None = None
    failure_kind: FailureKind | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @property
    def successful(self) -> bool:
        """Whether the step completed successfully."""

        return self.status == StepStatus.SUCCEEDED


@dataclass(frozen=True)
class RunResult:
    """Structured result for a whole workflow run."""

    run_id: str
    status: RunStatus
    step_results: tuple[StepResult, ...]
    failed_step_id: str | None = None
    blocker: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


HARNESS_PLAN_EXECUTOR_WORKFLOW = Workflow(
    name="harness-plan-executor",
    mode=RunMode.APPLY,
    description="Structured model of the existing harness-plan-executor skill flow.",
    steps=(
        Step(
            id="load-active-plan",
            kind=StepKind.RECORD,
            name="Read active plan, architecture, and design sources",
            inputs=(
                Path("docs/plans/active/plan.md"),
                Path("ARCHITECTURE.md"),
                Path("docs/design"),
            ),
        ),
        Step(
            id="delegate-implementation",
            kind=StepKind.AGENT,
            name="Delegate unchecked plan tasks to implementation_executor",
            needs=("load-active-plan",),
            agent_id="implementation_executor",
            inputs=(Path(".codex/agents/implementation_executor.toml"),),
        ),
        Step(
            id="inspect-executor-result",
            kind=StepKind.RECORD,
            name="Inspect updated plan and executor report",
            needs=("delegate-implementation",),
            inputs=(Path("docs/plans/active/plan.md"),),
        ),
        Step(
            id="run-final-verification",
            kind=StepKind.VALIDATOR,
            name="Run build, tests, static analysis, and runtime server verification when defined",
            needs=("inspect-executor-result",),
            metadata={
                "typical_commands": (
                    "./gradlew build",
                    "./gradlew test",
                    "./gradlew architectureRules",
                    "semgrep --config .semgrep/ddd-architecture.yml .",
                )
            },
        ),
        Step(
            id="classify-verification-failure",
            kind=StepKind.DECISION,
            name="Classify verification failure as implementation, upstream design, or environment blocker",
            needs=("run-final-verification",),
            metadata={
                "failure_kinds": tuple(kind.value for kind in FailureKind),
            },
        ),
        Step(
            id="record-remediation-or-blocker",
            kind=StepKind.RECORD,
            name="Record remediation tasks or blocker evidence in the active plan",
            needs=("classify-verification-failure",),
            outputs=(Path("docs/plans/active/plan.md"),),
        ),
        Step(
            id="complete-plan",
            kind=StepKind.GIT,
            name="Move completed plan from active to complete after all checks pass",
            needs=("run-final-verification",),
            inputs=(Path("docs/plans/active/plan.md"),),
            outputs=(Path("docs/plans/complete/plan.md"),),
        ),
    ),
)
