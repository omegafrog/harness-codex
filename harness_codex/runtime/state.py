"""Run state and resume support for use-case scoped workflows."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.models import RunMode, RunStatus


class UseCaseStep(str, Enum):
    """Coarse-grained steps in one use-case workflow loop."""

    PLAN = "plan"
    EXECUTE = "execute"
    VERIFY = "verify"
    REMEDIATE = "remediate"
    COMPLETE = "complete"


class ResumeDisposition(str, Enum):
    """Whether and where a run may resume."""

    NEXT_USE_CASE = "NEXT_USE_CASE"
    RETRY_REMEDIATION = "RETRY_REMEDIATION"
    WAIT_FOR_GOAL_CLARIFICATION = "WAIT_FOR_GOAL_CLARIFICATION"
    WAIT_FOR_CHANGESET_REVISION = "WAIT_FOR_CHANGESET_REVISION"
    WAIT_FOR_UPSTREAM_DESIGN = "WAIT_FOR_UPSTREAM_DESIGN"
    WAIT_FOR_ENVIRONMENT = "WAIT_FOR_ENVIRONMENT"
    COMPLETE = "COMPLETE"


class RunFailureKind(str, Enum):
    """Failure categories that decide resume behavior."""

    IMPLEMENTATION_FAILURE = "IMPLEMENTATION_FAILURE"
    UNCLEAR_E2E_GOAL = "UNCLEAR_E2E_GOAL"
    DOCUMENT_DELTA_CONFLICT = "DOCUMENT_DELTA_CONFLICT"
    UPSTREAM_DESIGN_CONFLICT = "UPSTREAM_DESIGN_CONFLICT"
    ENVIRONMENT_BLOCKER = "ENVIRONMENT_BLOCKER"


@dataclass(frozen=True)
class UseCaseLoopState:
    """Persisted state for one affected use-case loop."""

    uc_id: str
    active_plan_path: Path
    status: RunStatus = RunStatus.PENDING
    current_step_id: UseCaseStep = UseCaseStep.PLAN
    verification_status: str = ""
    retry_count: int = 0
    last_executor_result: Mapping[str, Any] = field(default_factory=dict)
    last_verifier_result: Mapping[str, Any] = field(default_factory=dict)
    failure_kind: RunFailureKind | None = None
    blocker: str | None = None


@dataclass(frozen=True)
class RunState:
    """Persisted state for a ChangeSet workflow run."""

    run_id: str
    change_set_id: str
    workflow_name: str
    mode: RunMode
    affected_use_cases: tuple[str, ...]
    current_use_case_id: str | None = None
    current_step_id: UseCaseStep | None = None
    completed_use_cases: tuple[str, ...] = ()
    blocked_use_cases: tuple[str, ...] = ()
    failed_step_id: str | None = None
    failure_kind: RunFailureKind | None = None
    status: RunStatus = RunStatus.PENDING
    use_case_states: tuple[UseCaseLoopState, ...] = ()


@dataclass(frozen=True)
class ResumeTarget:
    """Calculated next resume target for a stored run state."""

    disposition: ResumeDisposition
    uc_id: str | None = None
    step_id: UseCaseStep | None = None
    reason: str = ""


class RunStateStore:
    """JSON file store under `.harness/runs/<run-id>/state.json`."""

    def __init__(self, repo_root: Path | str) -> None:
        self.repo_root = Path(repo_root)

    def state_path(self, run_id: str) -> Path:
        return self.repo_root / ".harness/runs" / run_id / "state.json"

    def save(self, state: RunState) -> Path:
        path = self.state_path(state.run_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(_to_json(state), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return path

    def load(self, run_id: str) -> RunState:
        data = json.loads(self.state_path(run_id).read_text(encoding="utf-8"))
        return _run_state_from_json(data)


def decide_resume_target(state: RunState) -> ResumeTarget:
    """Decide where the workflow can resume from stored state."""

    if state.status == RunStatus.SUCCEEDED:
        return ResumeTarget(
            disposition=ResumeDisposition.COMPLETE,
            reason="run already succeeded",
        )

    if state.failure_kind == RunFailureKind.IMPLEMENTATION_FAILURE:
        return ResumeTarget(
            disposition=ResumeDisposition.RETRY_REMEDIATION,
            uc_id=state.current_use_case_id,
            step_id=UseCaseStep.REMEDIATE,
            reason="implementation failure can resume from remediation loop",
        )

    if state.failure_kind == RunFailureKind.UNCLEAR_E2E_GOAL:
        return ResumeTarget(
            disposition=ResumeDisposition.WAIT_FOR_GOAL_CLARIFICATION,
            uc_id=state.current_use_case_id,
            reason="E2E goal must be clarified before resume",
        )

    if state.failure_kind == RunFailureKind.DOCUMENT_DELTA_CONFLICT:
        return ResumeTarget(
            disposition=ResumeDisposition.WAIT_FOR_CHANGESET_REVISION,
            uc_id=state.current_use_case_id,
            reason="ChangeSet and UC documents conflict",
        )

    if state.failure_kind == RunFailureKind.UPSTREAM_DESIGN_CONFLICT:
        return ResumeTarget(
            disposition=ResumeDisposition.WAIT_FOR_UPSTREAM_DESIGN,
            uc_id=state.current_use_case_id,
            reason="upstream design or technical decision must change",
        )

    if state.failure_kind == RunFailureKind.ENVIRONMENT_BLOCKER:
        return ResumeTarget(
            disposition=ResumeDisposition.WAIT_FOR_ENVIRONMENT,
            uc_id=state.current_use_case_id,
            reason="environment blocker must be resolved before resume",
        )

    next_uc = _first_incomplete_use_case(state)
    if next_uc is not None:
        return ResumeTarget(
            disposition=ResumeDisposition.NEXT_USE_CASE,
            uc_id=next_uc,
            step_id=UseCaseStep.PLAN,
            reason="completed use cases are skipped",
        )

    return ResumeTarget(
        disposition=ResumeDisposition.COMPLETE,
        reason="all affected use cases are completed",
    )


def _first_incomplete_use_case(state: RunState) -> str | None:
    completed = set(state.completed_use_cases)
    blocked = set(state.blocked_use_cases)

    for uc_id in state.affected_use_cases:
        if uc_id not in completed and uc_id not in blocked:
            return uc_id

    return None


def _to_json(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, tuple):
        return [_to_json(item) for item in value]
    if hasattr(value, "__dataclass_fields__"):
        return {key: _to_json(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {key: _to_json(item) for key, item in value.items()}
    return value


def _run_state_from_json(data: Mapping[str, Any]) -> RunState:
    use_case_states = tuple(
        UseCaseLoopState(
            uc_id=item["uc_id"],
            active_plan_path=Path(item["active_plan_path"]),
            status=RunStatus(item["status"]),
            current_step_id=UseCaseStep(item["current_step_id"]),
            verification_status=item.get("verification_status", ""),
            retry_count=item.get("retry_count", 0),
            last_executor_result=item.get("last_executor_result", {}),
            last_verifier_result=item.get("last_verifier_result", {}),
            failure_kind=(
                RunFailureKind(item["failure_kind"])
                if item.get("failure_kind") is not None
                else None
            ),
            blocker=item.get("blocker"),
        )
        for item in data.get("use_case_states", [])
    )

    return RunState(
        run_id=data["run_id"],
        change_set_id=data["change_set_id"],
        workflow_name=data["workflow_name"],
        mode=RunMode(data["mode"]),
        affected_use_cases=tuple(data["affected_use_cases"]),
        current_use_case_id=data.get("current_use_case_id"),
        current_step_id=(
            UseCaseStep(data["current_step_id"])
            if data.get("current_step_id") is not None
            else None
        ),
        completed_use_cases=tuple(data.get("completed_use_cases", [])),
        blocked_use_cases=tuple(data.get("blocked_use_cases", [])),
        failed_step_id=data.get("failed_step_id"),
        failure_kind=(
            RunFailureKind(data["failure_kind"])
            if data.get("failure_kind") is not None
            else None
        ),
        status=RunStatus(data["status"]),
        use_case_states=use_case_states,
    )
