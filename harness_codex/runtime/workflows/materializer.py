"""Materialize workflow placeholders and gate policy from ChangeSet work-item scope."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from typing import Any

from harness_codex.runtime.changes.models import ChangeSet, PlanningInputScope, WorkItemType
from harness_codex.runtime.gate_policy import GatePolicy, GateRequirement, derive_gate_policy
from harness_codex.runtime.models import Step, StepDependency, StepKind, Workflow

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
    """Return a dependency-safe workflow bound to one approved work item.

    Steps for gates explicitly marked ``skipped`` are removed while materializing.
    This keeps the execution engine free from import-time monkey patches and records
    every removed gate in workflow metadata for the run manifest.
    """

    replacements = materialization_replacements(change_set, scope, run_id=run_id)
    policy = _policy_for_scope(change_set, scope)
    candidate_steps = tuple(
        _materialize_step(step, replacements, scope, policy)
        for step in workflow.steps
    )
    steps, skipped_gates = _remove_skipped_gate_steps(candidate_steps)
    materialized = replace(
        workflow,
        steps=steps,
        metadata={
            **dict(workflow.metadata),
            "materialized": True,
            "change_set_id": change_set.change_set_id,
            "work_item_id": scope.display_id,
            "work_item_type": scope.work_item_type.value,
            "work_item_profile": _work_item_profile(scope.work_item_type),
            "replacements": replacements,
            "gate_policy": policy.as_dict(),
            "skipped_gates": skipped_gates,
        },
    )
    unresolved = unresolved_placeholders(materialized)
    if unresolved:
        raise WorkflowMaterializationError(
            "unresolved workflow placeholders: " + ", ".join(sorted(unresolved))
        )
    _validate_materialized_workflow_contract(materialized)
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


def _work_item_profile(work_item_type: WorkItemType) -> str:
    return "use_case" if work_item_type == WorkItemType.USE_CASE else "maintenance"


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


def _policy_for_scope(change_set: ChangeSet, scope: PlanningInputScope) -> GatePolicy:
    """Use approved ChangeSet impact, not the plan's tentative file list."""

    impact_type = scope.impact_type or (scope.use_case.impact_type if scope.use_case is not None else "")
    for work_item in change_set.ordered_work_items():
        if work_item.work_item_id == scope.display_id:
            impact_type = work_item.impact_type
            break
    return derive_gate_policy(
        work_item_id=scope.display_id,
        work_item_type=scope.work_item_type,
        impact_type=impact_type,
    )


def _remove_skipped_gate_steps(
    steps: tuple[Step, ...],
) -> tuple[tuple[Step, ...], list[dict[str, object]]]:
    skipped = tuple(step for step in steps if _is_policy_skipped(step))
    skipped_by_id = {step.id: step for step in skipped}
    skipped_ids = set(skipped_by_id)
    skipped_gates = [dict(step.metadata.get("gate_policy", {})) for step in skipped]
    if not skipped_ids:
        return steps, skipped_gates

    retained: list[Step] = []
    for step in steps:
        if step.id in skipped_ids:
            continue
        upstream_context = step.metadata.get("upstream_context")
        if isinstance(upstream_context, list):
            upstream_context = [
                item
                for item in upstream_context
                if not (
                    isinstance(item, dict)
                    and str(item.get("producer_step", "")) in skipped_ids
                )
            ]
            metadata = {**dict(step.metadata), "upstream_context": upstream_context}
        else:
            metadata = step.metadata
        retained.append(
            replace(
                step,
                needs=_retarget_needs(step.needs, skipped_by_id),
                metadata=metadata,
            )
        )
    return tuple(retained), skipped_gates


def _retarget_needs(
    needs: tuple[StepDependency, ...],
    skipped_by_id: dict[str, Step],
) -> tuple[StepDependency, ...]:
    retargeted: list[StepDependency] = []
    for dependency in needs:
        if dependency.step_id not in skipped_by_id:
            retargeted.append(dependency)
            continue
        retargeted.extend(_retarget_needs(skipped_by_id[dependency.step_id].needs, skipped_by_id))
    return tuple(dict.fromkeys(retargeted))


def _is_policy_skipped(step: Step) -> bool:
    decision = step.metadata.get("gate_policy")
    return (
        isinstance(decision, dict)
        and decision.get("requirement") == GateRequirement.SKIPPED.value
    )


def _materialize_step(
    step: Step,
    replacements: dict[str, str],
    scope: PlanningInputScope,
    policy: GatePolicy,
) -> Step:
    materialized_inputs = tuple(
        _replace_path(path, replacements)
        for path in step.inputs
        if _input_is_applicable(path, replacements)
    )
    metadata = _replace_metadata(step.metadata, replacements)
    if isinstance(metadata, dict):
        gate_id = metadata.get("gate_id")
        if isinstance(gate_id, str) and gate_id:
            metadata = {
                **metadata,
                "gate_policy": policy.decision_for(gate_id).as_dict(),
            }
    return replace(
        step,
        id=_replace_text(step.id, replacements),
        name=_replace_text(step.name, replacements),
        needs=tuple(
            StepDependency(
                _replace_text(dependency.step_id, replacements),
                dependency.allowed_outcomes,
            )
            for dependency in step.needs
        ),
        agent_id=_replace_optional_text(step.agent_id, replacements),
        skill_id=_replace_optional_text(step.skill_id, replacements),
        command=_replace_optional_text(step.command, replacements),
        inputs=_scoped_inputs_for_step(materialized_inputs, step, scope),
        outputs=tuple(_replace_path(path, replacements) for path in step.outputs),
        metadata=metadata,
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

    if step.metadata.get("inputs_resolved_by") != "work_item_document_contract":
        return materialized_inputs

    stage = str(step.metadata.get("stage") or "")
    if stage in {"plan", "plan-writing", "security-review", "review"}:
        contract_inputs = scope.planner_inputs
    elif stage in {"execution", "implementation", "verification", "security-verification"}:
        contract_inputs = scope.executor_inputs
    else:
        contract_inputs = ()
    return tuple(dict.fromkeys((*materialized_inputs, *contract_inputs)))


def _validate_materialized_workflow_contract(workflow: Workflow) -> None:
    for step in workflow.steps:
        resolver = step.metadata.get("inputs_resolved_by")
        if resolver is not None and resolver != "work_item_document_contract":
            raise WorkflowMaterializationError(
                f"step `{step.id}` has unsupported inputs_resolved_by `{resolver}`"
            )
        if resolver == "work_item_document_contract" and step.kind == StepKind.GIT:
            raise WorkflowMaterializationError(
                f"step `{step.id}` cannot combine git moves with work item document contract inputs"
            )
        if step.kind == StepKind.GIT and step.command is None and (
            len(step.inputs) != 1 or len(step.outputs) != 1
        ):
            raise WorkflowMaterializationError(
                f"git step `{step.id}` without command requires exactly one input and one output"
            )


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
                "needs": [
                    {
                        "step": dependency.step_id,
                        "outcomes": list(dependency.allowed_outcomes),
                    }
                    for dependency in step.needs
                ],
                "inputs": [str(path) for path in step.inputs],
                "outputs": [str(path) for path in step.outputs],
                "gate_policy": step.metadata.get("gate_policy"),
            }
            for step in workflow.steps
        ],
    }
