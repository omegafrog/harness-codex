"""Workflow-declared dependency gate used immediately before step execution."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping

from harness_codex.runtime.models import StepResult, Workflow


@dataclass(frozen=True)
class DependencyViolation:
    code: str
    dependency_step_id: str
    expected_outcomes: tuple[str, ...]
    actual_outcome: str | None = None


@dataclass(frozen=True)
class DependencyCheckResult:
    allowed: bool
    violations: tuple[DependencyViolation, ...] = ()


def check_step_dependencies(
    *,
    workflow: Workflow,
    target_step_id: str,
    step_results: Mapping[str, StepResult],
) -> DependencyCheckResult:
    """판정만 수행한다. 다른 step이나 retry를 추천하지 않는다."""

    try:
        target = workflow.step_by_id(target_step_id)
    except KeyError:
        return DependencyCheckResult(
            allowed=False,
            violations=(DependencyViolation("TARGET_STEP_NOT_FOUND", target_step_id, ()),),
        )

    violations: list[DependencyViolation] = []
    for dependency in target.needs:
        try:
            workflow.step_by_id(dependency.step_id)
        except KeyError:
            violations.append(
                DependencyViolation(
                    "DEPENDENCY_STEP_NOT_FOUND",
                    dependency.step_id,
                    dependency.allowed_outcomes,
                )
            )
            continue

        result = step_results.get(dependency.step_id)
        if result is None:
            violations.append(
                DependencyViolation(
                    "DEPENDENCY_RESULT_NOT_FOUND",
                    dependency.step_id,
                    dependency.allowed_outcomes,
                )
            )
            continue

        actual = _result_outcome(result)
        if actual == "running":
            violations.append(
                DependencyViolation(
                    "DEPENDENCY_STILL_RUNNING",
                    dependency.step_id,
                    dependency.allowed_outcomes,
                    actual,
                )
            )
        elif actual not in dependency.allowed_outcomes:
            violations.append(
                DependencyViolation(
                    "DEPENDENCY_OUTCOME_NOT_ALLOWED",
                    dependency.step_id,
                    dependency.allowed_outcomes,
                    actual,
                )
            )

    return DependencyCheckResult(allowed=not violations, violations=tuple(violations))


def _result_outcome(result: StepResult) -> str:
    value = getattr(result, "outcome", None) or getattr(result, "status", None)
    return str(getattr(value, "value", value) or "").strip().lower()


__all__ = ["DependencyCheckResult", "DependencyViolation", "check_step_dependencies"]
