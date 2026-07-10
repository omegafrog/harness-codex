"""Workflow schema validation.

This module validates the external YAML workflow shape before it is converted
into runtime `Workflow` and `Step` objects.

It intentionally does not run the workflow.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

from harness_codex.runtime.models import RunMode, StepDependency, StepKind, StepStatus


class WorkflowSchemaError(ValueError):
    """Raised when a workflow YAML document is invalid."""


ALLOWED_SANDBOX_KINDS = frozenset({"worktree", "local"})


def require_mapping(value: Any, path: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise WorkflowSchemaError(f"{path} must be a mapping")

    return value


def require_sequence(value: Any, path: str) -> Sequence[Any]:
    if isinstance(value, str) or not isinstance(value, Sequence):
        raise WorkflowSchemaError(f"{path} must be a sequence")

    return value


def require_string(value: Any, path: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WorkflowSchemaError(f"{path} must be a non-empty string")

    return value


def require_optional_string(value: Any, path: str) -> str | None:
    if value is None:
        return None

    return require_string(value, path)


def require_optional_mapping(value: Any, path: str) -> Mapping[str, Any] | None:
    if value is None:
        return None

    return require_mapping(value, path)


def require_optional_positive_int(value: Any, path: str) -> int | None:
    if value is None:
        return None

    if not isinstance(value, int) or value <= 0:
        raise WorkflowSchemaError(f"{path} must be a positive integer")

    return value


def validate_version(document: Mapping[str, Any]) -> None:
    version = document.get("version")

    if version != 1:
        raise WorkflowSchemaError("version must be 1")


def validate_sandbox(value: Any) -> None:
    if value is None:
        return

    sandbox = require_mapping(value, "sandbox")
    kind = require_string(sandbox.get("kind"), "sandbox.kind")

    if kind not in ALLOWED_SANDBOX_KINDS:
        allowed = ", ".join(sorted(ALLOWED_SANDBOX_KINDS))
        raise WorkflowSchemaError(f"sandbox.kind must be one of: {allowed}")


def parse_run_mode(value: Any, path: str) -> RunMode:
    raw_mode = require_string(value, path)

    try:
        return RunMode(raw_mode)
    except ValueError as exc:
        allowed = ", ".join(mode.value for mode in RunMode)
        raise WorkflowSchemaError(f"{path} must be one of: {allowed}") from exc


def parse_step_kind(value: Any, path: str) -> StepKind:
    raw_kind = require_string(value, path)

    try:
        return StepKind(raw_kind)
    except ValueError as exc:
        allowed = ", ".join(kind.value for kind in StepKind)
        raise WorkflowSchemaError(f"{path} must be one of: {allowed}") from exc


def parse_needs(value: Any, path: str) -> tuple[StepDependency, ...]:
    if value is None:
        return ()

    sequence = require_sequence(value, path)
    needs: list[StepDependency] = []

    for index, item in enumerate(sequence):
        item_path = f"{path}[{index}]"
        if isinstance(item, str):
            needs.append(StepDependency(require_string(item, item_path)))
            continue
        dependency = require_mapping(item, item_path)
        step_id = require_string(dependency.get("step"), f"{item_path}.step")
        raw_outcomes = dependency.get("outcomes")
        outcomes = ("succeeded",) if raw_outcomes is None else tuple(
            require_string(outcome, f"{item_path}.outcomes[{outcome_index}]").lower()
            for outcome_index, outcome in enumerate(require_sequence(raw_outcomes, f"{item_path}.outcomes"))
        )
        allowed = {status.value for status in StepStatus}
        invalid = sorted(set(outcomes) - allowed)
        if invalid:
            raise WorkflowSchemaError(
                f"{item_path}.outcomes contains unsupported values: {', '.join(invalid)}"
            )
        needs.append(StepDependency(step_id, outcomes))

    return tuple(needs)


def parse_string_paths(value: Any, path: str) -> tuple[str, ...]:
    if value is None:
        return ()

    sequence = require_sequence(value, path)
    paths: list[str] = []

    for index, item in enumerate(sequence):
        paths.append(require_string(item, f"{path}[{index}]"))

    return tuple(paths)


def validate_workflow_document(document: Any) -> Mapping[str, Any]:
    root = require_mapping(document, "workflow document")
    validate_version(root)

    workflow = require_mapping(root.get("workflow"), "workflow")
    require_string(workflow.get("name"), "workflow.name")
    parse_run_mode(workflow.get("mode"), "workflow.mode")
    validate_sandbox(root.get("sandbox"))

    steps = require_sequence(root.get("steps"), "steps")

    if not steps:
        raise WorkflowSchemaError("steps must not be empty")

    seen_step_ids: set[str] = set()

    for index, raw_step in enumerate(steps):
        step_path = f"steps[{index}]"
        step = require_mapping(raw_step, step_path)

        step_id = require_string(step.get("id"), f"{step_path}.id")

        if step_id in seen_step_ids:
            raise WorkflowSchemaError(f"Duplicate step id: {step_id}")

        seen_step_ids.add(step_id)

        parse_step_kind(step.get("kind"), f"{step_path}.kind")
        require_optional_string(step.get("name"), f"{step_path}.name")
        parse_needs(step.get("needs"), f"{step_path}.needs")
        require_optional_string(step.get("agent_id"), f"{step_path}.agent_id")
        require_optional_string(step.get("skill_id"), f"{step_path}.skill_id")
        require_optional_string(step.get("provider"), f"{step_path}.provider")
        require_optional_string(step.get("command"), f"{step_path}.command")
        require_optional_positive_int(
            step.get("timeout_sec"), f"{step_path}.timeout_sec"
        )
        parse_string_paths(step.get("inputs"), f"{step_path}.inputs")
        parse_string_paths(step.get("outputs"), f"{step_path}.outputs")
        require_optional_mapping(step.get("metadata"), f"{step_path}.metadata")

    return root
