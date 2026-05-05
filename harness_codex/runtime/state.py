"""Run state and resume support for use-case scoped workflows."""

from __future__ import annotations

import json
import hashlib
from dataclasses import asdict, dataclass, field, replace as dataclass_replace
from enum import Enum
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.changes.models import WorkItemType


class UseCaseStep(str, Enum):
    """Coarse-grained steps in one use-case workflow loop."""

    PLAN = "plan"
    EXECUTE = "execute"
    VERIFY = "verify"
    REMEDIATE = "remediate"
    COMPLETE = "complete"


class MaintenanceStep(str, Enum):
    """Coarse-grained stages in one maintenance workflow loop."""

    INTENT = "intent"
    IMPACT_ANALYSIS = "impact_analysis"
    TECHNICAL_DECISIONS = "technical_decisions"
    VERIFICATION_GOAL = "verification_goal"
    PLAN = "plan"
    EXECUTE = "execute"
    VERIFY = "verify"
    REMEDIATE = "remediate"
    COMPLETE = "complete"


class ArtifactDirtyState(str, Enum):
    """Downstream impact status for one stage artifact."""

    CLEAN = "clean"
    DIRTY = "dirty"
    NEEDS_REAPPLY = "needs_reapply"
    CONFLICT = "conflict"


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
    SCOPE_CONFLICT = "SCOPE_CONFLICT"
    VERIFICATION_GOAL_UNCLEAR = "VERIFICATION_GOAL_UNCLEAR"


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
class WorkItemLoopState:
    """Persisted state for one generic ChangeSet work item."""

    work_item_id: str
    work_item_type: WorkItemType
    active_plan_path: Path
    status: RunStatus = RunStatus.PENDING
    current_step_id: str = "plan"
    verification_status: str = ""
    retry_count: int = 0
    last_executor_result: Mapping[str, Any] = field(default_factory=dict)
    last_verifier_result: Mapping[str, Any] = field(default_factory=dict)
    failure_kind: RunFailureKind | None = None
    blocker: str | None = None


@dataclass(frozen=True)
class StageArtifactState:
    """Checksum/revision state for a stage artifact."""

    stage: str
    path: Path
    checksum: str = ""
    revision: int = 0
    generated_by: str = "runtime"
    accepted: bool = False
    dirty_state: ArtifactDirtyState = ArtifactDirtyState.CLEAN
    downstream_status: ArtifactDirtyState = ArtifactDirtyState.CLEAN


@dataclass(frozen=True)
class RunState:
    """Persisted state for a ChangeSet workflow run."""

    run_id: str
    change_set_id: str
    workflow_name: str
    mode: RunMode
    affected_use_cases: tuple[str, ...]
    affected_work_items: tuple[str, ...] = ()
    current_use_case_id: str | None = None
    current_work_item_id: str | None = None
    current_step_id: UseCaseStep | None = None
    completed_use_cases: tuple[str, ...] = ()
    completed_work_items: tuple[str, ...] = ()
    blocked_use_cases: tuple[str, ...] = ()
    blocked_work_items: tuple[str, ...] = ()
    failed_step_id: str | None = None
    failure_kind: RunFailureKind | None = None
    status: RunStatus = RunStatus.PENDING
    use_case_states: tuple[UseCaseLoopState, ...] = ()
    work_item_states: tuple[WorkItemLoopState, ...] = ()
    artifact_states: tuple[StageArtifactState, ...] = ()


@dataclass(frozen=True)
class ResumeTarget:
    """Calculated next resume target for a stored run state."""

    disposition: ResumeDisposition
    uc_id: str | None = None
    work_item_id: str | None = None
    work_item_type: WorkItemType | None = None
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

    def save_artifact_acceptance(
        self,
        run_id: str,
        stage: str,
        path: Path,
        *,
        generated_by: str = "human",
    ) -> RunState:
        state = self.load(run_id)
        absolute = self.repo_root / path
        checksum = file_checksum(absolute) if absolute.exists() else ""
        previous = {item.stage: item for item in state.artifact_states}
        current = previous.get(stage)
        revision = (current.revision + 1) if current else 1
        previous[stage] = StageArtifactState(
            stage=stage,
            path=path,
            checksum=checksum,
            revision=revision,
            generated_by=generated_by,
            accepted=True,
            dirty_state=ArtifactDirtyState.CLEAN,
            downstream_status=ArtifactDirtyState.NEEDS_REAPPLY,
        )
        updated = dataclass_replace(
            state,
            artifact_states=tuple(previous.values()),
        )
        self.save(updated)
        return updated


def file_checksum(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
            work_item_id=state.current_work_item_id or state.current_use_case_id,
            work_item_type=_current_work_item_type(state),
            step_id=UseCaseStep.REMEDIATE,
            reason="implementation failure can resume from remediation loop",
        )

    if state.failure_kind == RunFailureKind.UNCLEAR_E2E_GOAL:
        return ResumeTarget(
            disposition=ResumeDisposition.WAIT_FOR_GOAL_CLARIFICATION,
            uc_id=state.current_use_case_id,
            work_item_id=state.current_work_item_id or state.current_use_case_id,
            work_item_type=_current_work_item_type(state),
            reason="E2E goal must be clarified before resume",
        )

    if state.failure_kind == RunFailureKind.DOCUMENT_DELTA_CONFLICT:
        return ResumeTarget(
            disposition=ResumeDisposition.WAIT_FOR_CHANGESET_REVISION,
            uc_id=state.current_use_case_id,
            work_item_id=state.current_work_item_id or state.current_use_case_id,
            work_item_type=_current_work_item_type(state),
            reason="ChangeSet and UC documents conflict",
        )

    if state.failure_kind == RunFailureKind.UPSTREAM_DESIGN_CONFLICT:
        return ResumeTarget(
            disposition=ResumeDisposition.WAIT_FOR_UPSTREAM_DESIGN,
            uc_id=state.current_use_case_id,
            work_item_id=state.current_work_item_id or state.current_use_case_id,
            work_item_type=_current_work_item_type(state),
            reason="upstream design or technical decision must change",
        )

    if state.failure_kind == RunFailureKind.ENVIRONMENT_BLOCKER:
        return ResumeTarget(
            disposition=ResumeDisposition.WAIT_FOR_ENVIRONMENT,
            uc_id=state.current_use_case_id,
            work_item_id=state.current_work_item_id or state.current_use_case_id,
            work_item_type=_current_work_item_type(state),
            reason="environment blocker must be resolved before resume",
        )

    next_work_item = _first_incomplete_work_item(state)
    if next_work_item is not None:
        return ResumeTarget(
            disposition=ResumeDisposition.NEXT_USE_CASE,
            uc_id=next_work_item if _work_item_type(state, next_work_item) == WorkItemType.USE_CASE else None,
            work_item_id=next_work_item,
            work_item_type=_work_item_type(state, next_work_item),
            step_id=UseCaseStep.PLAN,
            reason="completed work items are skipped",
        )

    next_uc = _first_incomplete_use_case(state)
    if next_uc is not None:
        return ResumeTarget(
            disposition=ResumeDisposition.NEXT_USE_CASE,
            uc_id=next_uc,
            work_item_id=next_uc,
            work_item_type=WorkItemType.USE_CASE,
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


def _first_incomplete_work_item(state: RunState) -> str | None:
    if not state.affected_work_items:
        return None

    completed = set(state.completed_work_items) | set(state.completed_use_cases)
    blocked = set(state.blocked_work_items) | set(state.blocked_use_cases)

    for work_item_id in state.affected_work_items:
        if work_item_id not in completed and work_item_id not in blocked:
            return work_item_id

    return None


def _current_work_item_type(state: RunState) -> WorkItemType | None:
    current = state.current_work_item_id or state.current_use_case_id
    if current is None:
        return None
    return _work_item_type(state, current)


def _work_item_type(state: RunState, work_item_id: str) -> WorkItemType:
    for item in state.work_item_states:
        if item.work_item_id == work_item_id:
            return item.work_item_type
    return WorkItemType.USE_CASE


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
    work_item_states = tuple(
        WorkItemLoopState(
            work_item_id=item["work_item_id"],
            work_item_type=WorkItemType(item["work_item_type"]),
            active_plan_path=Path(item["active_plan_path"]),
            status=RunStatus(item["status"]),
            current_step_id=item.get("current_step_id", "plan"),
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
        for item in data.get("work_item_states", [])
    )
    artifact_states = tuple(
        StageArtifactState(
            stage=item["stage"],
            path=Path(item["path"]),
            checksum=item.get("checksum", ""),
            revision=item.get("revision", 0),
            generated_by=item.get("generated_by", "runtime"),
            accepted=item.get("accepted", False),
            dirty_state=ArtifactDirtyState(item.get("dirty_state", "clean")),
            downstream_status=ArtifactDirtyState(
                item.get("downstream_status", "clean")
            ),
        )
        for item in data.get("artifact_states", [])
    )

    return RunState(
        run_id=data["run_id"],
        change_set_id=data["change_set_id"],
        workflow_name=data["workflow_name"],
        mode=RunMode(data["mode"]),
        affected_use_cases=tuple(data["affected_use_cases"]),
        affected_work_items=tuple(data.get("affected_work_items", [])),
        current_use_case_id=data.get("current_use_case_id"),
        current_work_item_id=data.get("current_work_item_id"),
        current_step_id=(
            UseCaseStep(data["current_step_id"])
            if data.get("current_step_id") is not None
            else None
        ),
        completed_use_cases=tuple(data.get("completed_use_cases", [])),
        completed_work_items=tuple(data.get("completed_work_items", [])),
        blocked_use_cases=tuple(data.get("blocked_use_cases", [])),
        blocked_work_items=tuple(data.get("blocked_work_items", [])),
        failed_step_id=data.get("failed_step_id"),
        failure_kind=(
            RunFailureKind(data["failure_kind"])
            if data.get("failure_kind") is not None
            else None
        ),
        status=RunStatus(data["status"]),
        use_case_states=use_case_states,
        work_item_states=work_item_states,
        artifact_states=artifact_states,
    )
