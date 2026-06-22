"""Materialize workflow placeholders from ChangeSet work item scope."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from typing import Any

from harness_codex.runtime.changes.models import ChangeSet, PlanningInputScope, WorkItemType
from harness_codex.runtime.models import Step, Workflow

_PLACEHOLDER_PATTERN = re.compile(r"<[A-Z][A-Z0-9_-]*>")


class WorkflowMaterializationError(ValueError):
    """Raised when a workflow still contains unresolved placeholders."""


def materialize_workflow_for_scope(
    workflow: Workflow,
    change_set: ChangeSet,
    scope: PlanningInputScope,
    *,
    run_id: str = "",
) -> Workflow:
    """Return one workflow bound to the selected work-item document contract."""

    replacements = materialization_replacements(change_set, scope, run_id=run_id)
    steps = tuple(_materialize_step(step, replacements, scope) for step in workflow.steps)
    materialized = replace(
        workflow,
        steps=steps,
        metadata={
            **dict(workflow.metadata),
            "materialized": True,
            "change_set_id": change_set.change_set_id,
            "work_item_id": scope.display_id,
            "work_item_type": scope.work_item_type.value,
            "replacements": replacements,
        },
    )
    unresolved = unresolved_placeholders(materialized)
    if unresolved:
        raise WorkflowMaterializationError(
            "unresolved workflow placeholders: " + ", ".join(sorted(unresolved))
        )
    return materialized


def materialization_replacements(
    change_set: ChangeSet,
    scope: PlanningInputScope,
    *,
    run_id: str = "",
) -> dict[str, str]:
    """Return placeholder replacement values for a ChangeSet work item scope."""

    uc_id = scope.use_case.uc_id if scope.use_case is not None else ""
    maint_id = scope.display_id if scope.work_item_type == WorkItemType.MAINTENANCE else ""
    return {
        "<CHG-ID>": change_set.change_set_id,
        "<UC-ID>": uc_id,
        "<MAINT-ID>": maint_id,
        "<WORK-ITEM-ID>": scope.display_id,
        "<RUN-ID>": run_id,
    }


def unresolved_placeholders(workflow: Workflow) -> frozenset[str]:
    """Return placeholders still present in materialized workflow fields."""

    values: list[str] = [workflow.name]
    if workflow.description:
        values.append(workflow.description)
    for step in workflow.steps:
        values.extend(
            value
            for value in (
                step.id,
                step.name,
                step.agent_id or "",
                step.skill_id or "",
                step.command or "",
            )
            if value
        )
        values.extend(str(path) for path in step.inputs)
        values.extend(str(path) for path in step.outputs)
        values.extend(_metadata_strings(step.metadata))
    return frozenset(
        placeholder
        for value in values
        for placeholder in _PLACEHOLDER_PATTERN.findall(value)
    )


def write_materialized_workflow_manifest(workflow: Workflow, path: Path) -> None:
    """Write a compact materialized workflow manifest for run auditing."""

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(_workflow_manifest(workflow), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _materialize_step(
    step: Step,
    replacements: dict[str, str],
    scope: PlanningInputScope,
) -> Step:
    materialized_inputs = tuple(
        _replace_path(path, replacements)
        for path in step.inputs
        if _input_is_applicable(path, replacements)
    )
    return replace(
        step,
        id=_replace_text(step.id, replacements),
        name=_replace_text(step.name, replacements),
        needs=tuple(_replace_text(need, replacements) for need in step.needs),
        agent_id=_replace_optional_text(step.agent_id, replacements),
        skill_id=_replace_optional_text(step.skill_id, replacements),
        command=_replace_optional_text(step.command, replacements),
        inputs=_scoped_inputs_for_step(materialized_inputs, step, scope),
        outputs=tuple(_replace_path(path, replacements) for path in step.outputs),
        metadata=_replace_metadata(step.metadata, replacements),
    )


def _input_is_applicable(path: Path, replacements: dict[str, str]) -> bool:
    raw_path = str(path)
    return not (
        ("<UC-ID>" in raw_path and not replacements["<UC-ID>"])
        or ("<MAINT-ID>" in raw_path and not replacements["<MAINT-ID>"])
    )


def _scoped_inputs_for_step(
    materialized_inputs: tuple[Path, ...],
    step: Step,
    scope: PlanningInputScope,
) -> tuple[Path, ...]:
    """Combine stable step inputs with the selected type-specific documents."""

    stage = str(step.metadata.get("stage") or "")
    if stage in {"plan", "security-review", "review"}:
        contract_inputs = scope.planner_inputs
    elif stage in {"execution", "verification"}:
        contract_inputs = scope.executor_inputs
    else:
        contract_inputs = ()
    return tuple(dict.fromkeys((*materialized_inputs, *contract_inputs)))


def _replace_optional_text(value: str | None, replacements: dict[str, str]) -> str | None:
    if value is None:
        return None
    return _replace_text(value, replacements)


def _replace_path(path: Path, replacements: dict[str, str]) -> Path:
    return Path(_replace_text(str(path), replacements))


def _replace_text(value: str, replacements: dict[str, str]) -> str:
    result = value
    for placeholder, replacement in replacements.items():
        result = result.replace(placeholder, replacement)
    return result


def _replace_metadata(value: Any, replacements: dict[str, str]) -> Any:
    if isinstance(value, str):
        return _replace_text(value, replacements)
    if isinstance(value, Path):
        return _replace_path(value, replacements)
    if isinstance(value, tuple):
        return tuple(_replace_metadata(item, replacements) for item in value)
    if isinstance(value, list):
        return [_replace_metadata(item, replacements) for item in value]
    if isinstance(value, dict):
        return {
            _replace_text(str(key), replacements): _replace_metadata(item, replacements)
            for key, item in value.items()
        }
    return value


def _metadata_strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, Path):
        return [str(value)]
    if isinstance(value, dict):
        strings: list[str] = []
        for key, item in value.items():
            strings.append(str(key))
            strings.extend(_metadata_strings(item))
        return strings
    if isinstance(value, (list, tuple)):
        strings: list[str] = []
        for item in value:
            strings.extend(_metadata_strings(item))
        return strings
    return []


def _workflow_manifest(workflow: Workflow) -> dict[str, Any]:
    return {
        "name": workflow.name,
        "mode": workflow.mode.value,
        "metadata": dict(workflow.metadata),
        "steps": [
            {
                "id": step.id,
                "kind": step.kind.value,
                "agent_id": step.agent_id,
                "skill_id": step.skill_id,
                "command": step.command,
                "needs": list(step.needs),
                "inputs": [str(path) for path in step.inputs],
                "outputs": [str(path) for path in step.outputs],
            }
            for step in workflow.steps
        ],
    }
