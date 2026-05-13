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
    skill_id: str | None = None
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
    metadata: Mapping[str, Any] = field(default_factory=dict)


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
    mode: RunMode | None = None
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
            name="Move completed plan from active to completed after all checks pass",
            needs=("run-final-verification",),
            inputs=(Path("docs/plans/active/plan.md"),),
            outputs=(Path("docs/plans/completed/plan.md"),),
        ),
    ),
)

HARNESS_HARVEST_WORKFLOW = Workflow(
    name="harness-harvest-workflow",
    mode=RunMode.APPLY,
    description=(
        "Harvest initial product intent into canonical requirements and use-case "
        "design documents through the requirements/use-cases agent."
    ),
    steps=(
        Step(
            id="harvest-requirements-use-cases",
            kind=StepKind.AGENT,
            name="Derive requirements and use cases from the initial product idea",
            agent_id="harness_requirements_usecases",
            skill_id="harness-requirements-usecases",
            outputs=(
                Path("docs/design/요구사항.md"),
                Path("docs/design/유스케이스.md"),
            ),
            metadata={
                "stage": "harvest",
                "scope": "canonical_design",
                "purpose": (
                    "Create or update the harvested design inputs that downstream "
                    "ChangeSet and use-case orchestration consumes."
                ),
            },
        ),
    ),
)

HARNESS_FULL_WORKFLOW = Workflow(
    name="harness-full-workflow",
    mode=RunMode.APPLY,
    description=(
        "Full harness lifecycle: harvest product intent, create a ChangeSet, "
        "identify affected use cases, and run use-case scoped planning, "
        "execution, E2E verification, remediation, and completion."
    ),
    steps=(
        Step(
            id="harvest-requirements-use-cases",
            kind=StepKind.AGENT,
            name="Derive requirements and use cases from the initial product idea",
            agent_id="harness_requirements_usecases",
            skill_id="harness-requirements-usecases",
            outputs=(
                Path("docs/design/요구사항.md"),
                Path("docs/design/유스케이스.md"),
            ),
            metadata={
                "stage": "harvest",
                "scope": "canonical_design",
                "purpose": (
                    "Produce the canonical requirements/use-case inputs before "
                    "post-harvest ChangeSet orchestration begins."
                ),
            },
        ),
        Step(
            id="capture-implementation-intent",
            kind=StepKind.RECORD,
            name="Capture implementation prompt or change request",
            needs=("harvest-requirements-use-cases",),
            outputs=(
                Path("docs/changes/active"),
            ),
            metadata={
                "stage": "intake",
                "scope": "change_set",
                "purpose": (
                    "Record the implementation intent that will be tracked as "
                    "a ChangeSet instead of a repository-wide active plan."
                ),
            },
        ),
        Step(
            id="create-change-set",
            kind=StepKind.RECORD,
            name="Create active ChangeSet from captured implementation intent",
            needs=("capture-implementation-intent",),
            inputs=(
                Path("docs/templates/changes/change-set.md"),
            ),
            outputs=(Path("docs/changes/active/<CHG-ID>.md"),),
            metadata={
                "stage": "change-set",
                "scope": "change_set",
                "purpose": (
                    "Create the source-of-truth ChangeSet that bounds the "
                    "subsequent use-case scoped workflow."
                ),
            },
        ),
        Step(
            id="identify-affected-use-cases",
            kind=StepKind.DECISION,
            name="Identify use cases affected by the active ChangeSet",
            needs=("create-change-set",),
            inputs=(
                Path("docs/changes/active/<CHG-ID>.md"),
                Path("docs/use-cases"),
            ),
            metadata={
                "stage": "change-set",
                "scope": "affected_use_cases",
                "purpose": (
                    "Resolve the affected UC list before any UC-specific "
                    "event storming, design, planning, or execution starts."
                ),
            },
        ),
        Step(
            id="storm-affected-use-case",
            kind=StepKind.AGENT,
            name="Run event storming for one affected use-case slice",
            needs=("identify-affected-use-cases",),
            agent_id="oracle",
            inputs=(
                Path("docs/changes/active/<CHG-ID>.md"),
                Path("docs/use-cases/<UC-ID>/use-case.md"),
            ),
            outputs=(Path("docs/use-cases/<UC-ID>/event-storming.md"),),
            metadata={
                "stage": "event-storming",
                "scope": "use_case",
                "purpose": (
                    "Update only the affected use-case event storming slice "
                    "within the active ChangeSet boundary."
                ),
            },
        ),
        Step(
            id="design-affected-use-case",
            kind=StepKind.AGENT,
            name="Derive DDD design for one affected use-case slice",
            needs=("storm-affected-use-case",),
            agent_id="ddd_architect",
            inputs=(
                Path("docs/changes/active/<CHG-ID>.md"),
                Path("docs/use-cases/<UC-ID>/event-storming.md"),
            ),
            outputs=(Path("docs/use-cases/<UC-ID>/ddd-design.md"),),
            metadata={
                "stage": "ddd-design",
                "scope": "use_case",
                "purpose": (
                    "Keep design updates scoped to the affected use case "
                    "instead of rewriting repository-wide design artifacts."
                ),
            },
        ),
        Step(
            id="planner-create-use-case-plan",
            kind=StepKind.AGENT,
            name="Create an implementation plan for one affected use case",
            needs=("design-affected-use-case",),
            agent_id="implementation_planner",
            inputs=(
                Path("docs/changes/active/<CHG-ID>.md"),
                Path("docs/use-cases/<UC-ID>"),
                Path("ARCHITECTURE.md"),
            ),
            outputs=(Path("docs/plans/active/<UC-ID>/plan.md"),),
            metadata={
                "stage": "planner",
                "scope": "use_case",
                "purpose": (
                    "Create a plan whose completion target is the affected "
                    "use-case E2E goal."
                ),
            },
        ),
        Step(
            id="executor-implement-use-case-plan",
            kind=StepKind.AGENT,
            name="Implement unchecked tasks in one use-case scoped plan",
            needs=("planner-create-use-case-plan",),
            agent_id="implementation_executor",
            inputs=(
                Path("docs/plans/active/<UC-ID>/plan.md"),
                Path("docs/use-cases/<UC-ID>"),
                Path("docs/changes/active/<CHG-ID>.md"),
                Path("ARCHITECTURE.md"),
                Path(".codex/agents/implementation_executor.toml"),
            ),
            outputs=(Path("docs/plans/active/<UC-ID>/plan.md"),),
            metadata={
                "stage": "executor",
                "scope": "use_case",
                "purpose": (
                    "Implement only the current UC plan and update that plan "
                    "after focused verification."
                ),
            },
        ),
        Step(
            id="verifier-run-use-case-e2e",
            kind=StepKind.VALIDATOR,
            name="Run E2E goal and quality gates for one affected use case",
            needs=("executor-implement-use-case-plan",),
            inputs=(
                Path("docs/plans/active/<UC-ID>/plan.md"),
                Path("docs/use-cases/<UC-ID>/e2e-goal.md"),
                Path(".codex/test-gate.yaml"),
            ),
            metadata={
                "stage": "verifier",
                "scope": "use_case",
                "typical_commands": (
                    "./gradlew build",
                    "./gradlew test",
                    "./gradlew e2eTest",
                    "./gradlew architectureRules",
                    "semgrep --config .semgrep/ddd-architecture.yml .",
                ),
                "test_gate": ".codex/test-gate.yaml required stages must PASS",
                "purpose": (
                    "Verify the implemented UC against its E2E goal and "
                    "repository quality gates."
                ),
            },
        ),
        Step(
            id="classify-use-case-verification-result",
            kind=StepKind.DECISION,
            name="Decide whether to complete, remediate, or stop the use case",
            needs=("verifier-run-use-case-e2e",),
            metadata={
                "stage": "verifier",
                "scope": "use_case",
                "on_success": "complete-use-case-plan",
                "on_implementation_failure": "revise-use-case-plan-and-repeat",
                "on_upstream_design_failure": "record-use-case-blocker",
                "on_environment_blocker": "record-use-case-blocker",
                "purpose": (
                    "Classify verification result before repeating only the "
                    "affected UC plan loop or stopping with blocker evidence."
                ),
            },
        ),
        Step(
            id="revise-use-case-plan-and-repeat",
            kind=StepKind.RECORD,
            name="Record remediation tasks and repeat the UC executor loop",
            needs=("classify-use-case-verification-result",),
            outputs=(Path("docs/plans/active/<UC-ID>/plan.md"),),
            metadata={
                "stage": "orchestrator",
                "scope": "use_case",
                "loop_target": "executor-implement-use-case-plan",
                "loop_until": "use_case_e2e_passes_or_blocker",
                "purpose": (
                    "Append remediation only to the failing UC plan and repeat "
                    "that UC's executor/E2E verification loop."
                ),
            },
        ),
        Step(
            id="record-use-case-blocker",
            kind=StepKind.RECORD,
            name="Record blocker evidence for one affected use case",
            needs=("classify-use-case-verification-result",),
            outputs=(Path("docs/plans/active/<UC-ID>/plan.md"),),
            metadata={
                "stage": "orchestrator",
                "scope": "use_case",
                "stop_reasons": (
                    "upstream_design_blocker",
                    "environment_blocker",
                ),
                "purpose": (
                    "Stop the UC loop when failure cannot be remediated inside "
                    "the current UC plan and ChangeSet boundary."
                ),
            },
        ),
        Step(
            id="complete-use-case-plan",
            kind=StepKind.GIT,
            name="Move the completed UC plan out of active plans",
            needs=("classify-use-case-verification-result",),
            inputs=(Path("docs/plans/active/<UC-ID>/plan.md"),),
            outputs=(Path("docs/plans/completed/<UC-ID>/plan.md"),),
            metadata={
                "stage": "completion",
                "scope": "use_case",
                "condition": "use_case_e2e_goal_and_quality_gates_passed",
                "purpose": (
                    "Complete only the UC plan whose tasks and E2E gate passed."
                ),
            },
        ),
        Step(
            id="complete-change-set",
            kind=StepKind.GIT,
            name="Complete the active ChangeSet after all affected UCs complete",
            needs=("complete-use-case-plan",),
            inputs=(Path("docs/changes/active/<CHG-ID>.md"),),
            outputs=(Path("docs/changes/completed/<CHG-ID>.md"),),
            metadata={
                "stage": "completion",
                "scope": "change_set",
                "condition": "all_affected_use_case_plans_completed",
                "purpose": (
                    "Complete the ChangeSet only after every affected UC plan "
                    "has passed and moved to completed plans."
                ),
            },
        ),
    ),
)
