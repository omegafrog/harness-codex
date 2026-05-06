"""ChangeSet work item 단위 plan/execute/verify loop."""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path

from harness_codex.runtime.changes.models import ChangeSet, PlanningInputScope
from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunStatus,
    Step,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.runner import StepRunner


@dataclass(frozen=True)
class WorkItemLoopResult:
    """하나의 work item loop 결과."""

    scope: PlanningInputScope
    status: RunStatus
    step_results: tuple[StepResult, ...]
    retry_count: int = 0
    current_stage: str = "plan"
    verification_status: str = ""
    completed_plan_path: Path | None = None
    failed_step_id: str | None = None
    blocker: str | None = None
    failure_kind: FailureKind | None = None


@dataclass(frozen=True)
class ChangeSetLoopResult:
    """ChangeSet work item loop 전체 결과."""

    run_id: str
    status: RunStatus
    item_results: tuple[WorkItemLoopResult, ...]

    @property
    def completed_work_items(self) -> tuple[str, ...]:
        return tuple(
            result.scope.display_id
            for result in self.item_results
            if result.status == RunStatus.SUCCEEDED
        )

    @property
    def blocked_work_items(self) -> tuple[str, ...]:
        return tuple(
            result.scope.display_id
            for result in self.item_results
            if result.status == RunStatus.BLOCKED
        )

    @property
    def failed_work_items(self) -> tuple[str, ...]:
        return tuple(
            result.scope.display_id
            for result in self.item_results
            if result.status == RunStatus.FAILED
        )


class WorkItemLoopRunner:
    """planner -> executor -> verifier를 work item별로 반복 실행한다."""

    def __init__(
        self,
        *,
        step_runner: StepRunner,
        workflow: Workflow,
        max_retries: int = 1,
    ) -> None:
        self._step_runner = step_runner
        self._workflow = workflow
        self._max_retries = max_retries

    def run(
        self,
        *,
        change_set: ChangeSet,
        scopes: tuple[PlanningInputScope, ...],
        context: RunContext,
    ) -> ChangeSetLoopResult:
        results: list[WorkItemLoopResult] = []

        for scope in scopes:
            item_result = self._run_one(change_set, scope, context)
            results.append(item_result)
            if item_result.status != RunStatus.SUCCEEDED:
                break

        return ChangeSetLoopResult(
            run_id=context.run_id,
            status=_aggregate_status(tuple(results), expected_count=len(scopes)),
            item_results=tuple(results),
        )

    def _run_one(
        self,
        change_set: ChangeSet,
        scope: PlanningInputScope,
        context: RunContext,
    ) -> WorkItemLoopResult:
        item_context = replace(
            context,
            active_plan_path=_plan_path(scope),
            metadata={
                **dict(context.metadata),
                "current_work_item": _scope_metadata(scope),
            },
        )
        step_results: list[StepResult] = []

        load_result = self._run_step("load-change-set", change_set, scope, item_context)
        step_results.append(load_result)
        if not load_result.successful:
            return _stopped_result(scope, step_results, "plan", load_result)

        plan_result = self._run_step("plan-work-item", change_set, scope, item_context)
        step_results.append(plan_result)
        if not plan_result.successful:
            return _stopped_result(scope, step_results, "plan", plan_result)

        retry_count = 0
        while True:
            execute_result = self._run_step(
                "execute-work-item",
                change_set,
                scope,
                item_context,
            )
            step_results.append(execute_result)
            if not execute_result.successful:
                return _stopped_result(
                    scope,
                    step_results,
                    "execute",
                    execute_result,
                    retry_count=retry_count,
                )

            verify_result = self._run_step(
                "verify-work-item",
                change_set,
                scope,
                item_context,
            )
            step_results.append(verify_result)
            if verify_result.successful:
                break

            if verify_result.failure_kind != FailureKind.IMPLEMENTATION:
                return _stopped_result(
                    scope,
                    step_results,
                    "verify",
                    verify_result,
                    retry_count=retry_count,
                )

            if retry_count >= self._max_retries:
                return _stopped_result(
                    scope,
                    step_results,
                    "verify",
                    verify_result,
                    retry_count=retry_count,
                )

            retry_count += 1
            self._record_remediation(scope, item_context, retry_count, verify_result)

        classify_result = self._run_step(
            "classify-verification-result",
            change_set,
            scope,
            item_context,
        )
        step_results.append(classify_result)
        if not classify_result.successful:
            return _stopped_result(
                scope,
                step_results,
                "verify",
                classify_result,
                retry_count=retry_count,
            )

        complete_result = self._run_step(
            "complete-work-item-plan",
            change_set,
            scope,
            item_context,
        )
        step_results.append(complete_result)
        if not complete_result.successful:
            return _stopped_result(
                scope,
                step_results,
                "complete",
                complete_result,
                retry_count=retry_count,
            )

        return WorkItemLoopResult(
            scope=scope,
            status=RunStatus.SUCCEEDED,
            step_results=tuple(step_results),
            retry_count=retry_count,
            current_stage="complete",
            verification_status=StepStatus.SUCCEEDED.value,
            completed_plan_path=_completed_plan_path(scope),
        )

    def _run_step(
        self,
        step_id: str,
        change_set: ChangeSet,
        scope: PlanningInputScope,
        context: RunContext,
    ) -> StepResult:
        step = _materialize_step(
            self._workflow.step_by_id(step_id),
            change_set,
            scope,
        )
        return self._step_runner.run(step, context)

    def _record_remediation(
        self,
        scope: PlanningInputScope,
        context: RunContext,
        retry_count: int,
        failed_result: StepResult,
    ) -> None:
        item_dir = (
            context.run_dir
            / "work-items"
            / scope.display_id
            / "remediation"
        )
        item_dir.mkdir(parents=True, exist_ok=True)
        evidence = failed_result.error or failed_result.status.value
        text = "\n".join(
            [
                f"# 재실행 계획 {retry_count}",
                "",
                f"- Work item: `{scope.display_id}`",
                f"- 실패 단계: `{failed_result.step_id}`",
                f"- 실패 유형: `{FailureKind.IMPLEMENTATION.value}`",
                f"- 실패 증거: {evidence}",
                "",
            ]
        )
        (item_dir / f"{retry_count}.md").write_text(text, encoding="utf-8")

        plan_path = context.repo_root / _plan_path(scope)
        if plan_path.exists():
            with plan_path.open("a", encoding="utf-8") as file:
                file.write("\n" + text)


def _materialize_step(
    step: Step,
    change_set: ChangeSet,
    scope: PlanningInputScope,
) -> Step:
    if step.id == "plan-work-item":
        return replace(
            step,
            inputs=scope.planner_inputs,
            outputs=(_plan_path(scope),),
            metadata=_step_metadata(step, scope),
        )
    if step.id == "execute-work-item":
        return replace(
            step,
            inputs=scope.executor_inputs,
            outputs=(_plan_path(scope),),
            metadata=_step_metadata(step, scope),
        )
    if step.id == "verify-work-item":
        inputs = tuple(
            path
            for path in (
                _plan_path(scope),
                scope.verification_goal_path,
                Path(".codex/test-gate.yaml"),
            )
            if path is not None
        )
        return replace(step, inputs=inputs, metadata=_step_metadata(step, scope))
    if step.id == "complete-work-item-plan":
        return replace(
            step,
            inputs=(_plan_path(scope),),
            outputs=(_completed_plan_path(scope),),
            metadata=_step_metadata(step, scope),
        )

    return replace(
        step,
        inputs=_replace_placeholders(step.inputs, change_set, scope),
        outputs=_replace_placeholders(step.outputs, change_set, scope),
        metadata=_step_metadata(step, scope),
    )


def _replace_placeholders(
    paths: tuple[Path, ...],
    change_set: ChangeSet,
    scope: PlanningInputScope,
) -> tuple[Path, ...]:
    return tuple(
        Path(
            str(path)
            .replace("<CHG-ID>", change_set.change_set_id)
            .replace("<WORK-ITEM-ID>", scope.display_id)
            .replace("<UC-ID>", scope.use_case.uc_id if scope.use_case else "")
            .replace("<MAINT-ID>", scope.display_id)
        )
        for path in paths
    )


def _step_metadata(step: Step, scope: PlanningInputScope) -> dict[str, object]:
    return {
        **dict(step.metadata),
        "work_item_id": scope.display_id,
        "work_item_type": scope.work_item_type.value,
        "plan_path": str(_plan_path(scope)),
        "verification_goal_path": (
            str(scope.verification_goal_path) if scope.verification_goal_path else None
        ),
    }


def _scope_metadata(scope: PlanningInputScope) -> dict[str, object]:
    return {
        "id": scope.display_id,
        "type": scope.work_item_type.value,
        "plan_path": str(_plan_path(scope)),
        "planner_inputs": [str(path) for path in scope.planner_inputs],
        "executor_inputs": [str(path) for path in scope.executor_inputs],
        "verification_goal_path": (
            str(scope.verification_goal_path) if scope.verification_goal_path else None
        ),
    }


def _plan_path(scope: PlanningInputScope) -> Path:
    return scope.plan_path or Path(f"docs/plans/active/{scope.display_id}/plan.md")


def _completed_plan_path(scope: PlanningInputScope) -> Path:
    return Path(f"docs/plans/completed/{scope.display_id}/plan.md")


def _stopped_result(
    scope: PlanningInputScope,
    step_results: list[StepResult],
    current_stage: str,
    result: StepResult,
    *,
    retry_count: int = 0,
) -> WorkItemLoopResult:
    status = (
        RunStatus.BLOCKED
        if result.status == StepStatus.BLOCKED
        else RunStatus.FAILED
    )
    return WorkItemLoopResult(
        scope=scope,
        status=status,
        step_results=tuple(step_results),
        retry_count=retry_count,
        current_stage=current_stage,
        verification_status=result.status.value,
        failed_step_id=result.step_id,
        blocker=result.error,
        failure_kind=result.failure_kind,
    )


def _aggregate_status(
    results: tuple[WorkItemLoopResult, ...],
    *,
    expected_count: int,
) -> RunStatus:
    if not results:
        return RunStatus.PENDING
    if any(result.status == RunStatus.BLOCKED for result in results):
        return RunStatus.BLOCKED
    if any(result.status == RunStatus.FAILED for result in results):
        return RunStatus.FAILED
    if len(results) == expected_count:
        return RunStatus.SUCCEEDED
    return RunStatus.RUNNING
