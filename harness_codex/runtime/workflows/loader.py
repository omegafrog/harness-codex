"""Load workflow YAML files into runtime models."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Mapping

import yaml

from harness_codex.runtime.engine import RunnerEngine, WorkflowValidationError
from harness_codex.runtime.models import RunMode, Step, StepKind, Workflow
from harness_codex.runtime.workflows.schema import (
    WorkflowSchemaError,
    parse_needs,
    parse_run_mode,
    parse_step_kind,
    parse_string_paths,
    validate_workflow_document,
)


DEFAULT_WORKFLOW_DIR = Path(".harness/workflows")


def load_named_workflow(
    name: str,
    workflows_dir: Path | str = DEFAULT_WORKFLOW_DIR,
) -> Workflow:
    workflow_name = name.removesuffix(".yaml")
    workflow_path = Path(workflows_dir) / f"{workflow_name}.yaml"
    workflow = load_workflow_file(workflow_path)
    if workflow.name != workflow_name:
        raise WorkflowSchemaError(
            f"workflow name mismatch: requested {workflow_name}, found {workflow.name}"
        )
    return workflow


def load_workflow_file(path: Path | str) -> Workflow:
    workflow_path = Path(path).resolve()
    content = workflow_path.read_bytes()
    return load_workflow_text(
        content.decode("utf-8"),
        source_path=workflow_path,
        source_sha256=hashlib.sha256(content).hexdigest(),
    )


def load_workflow_text(
    text: str,
    *,
    source_path: Path | None = None,
    source_sha256: str = "",
) -> Workflow:
    try:
        document = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        raise WorkflowSchemaError(f"Invalid workflow YAML: {exc}") from exc

    if document is None:
        raise WorkflowSchemaError("workflow document must not be empty")

    validated = validate_workflow_document(document)
    workflow = _to_workflow(
        validated,
        source_path=source_path,
        source_sha256=source_sha256,
    )

    # Reuse RunnerEngine's graph validation so YAML and runtime execution share
    # the same duplicate/unknown dependency/cycle rules.
    try:
        RunnerEngine(step_runner=_NoopStepRunner()).plan(workflow)
    except WorkflowValidationError as exc:
        raise WorkflowSchemaError(str(exc)) from exc

    return workflow


def _to_workflow(
    document: Mapping[str, Any],
    *,
    source_path: Path | None = None,
    source_sha256: str = "",
) -> Workflow:
    raw_workflow = document["workflow"]
    raw_steps = document["steps"]

    steps = tuple(_to_step(raw_step) for raw_step in raw_steps)

    return Workflow(
        name=raw_workflow["name"],
        mode=parse_run_mode(raw_workflow["mode"], "workflow.mode"),
        steps=steps,
        description=raw_workflow.get("description"),
        metadata={
            "version": document["version"],
            "sandbox": document.get("sandbox"),
        },
        source_path=source_path,
        source_sha256=source_sha256,
    )


def validate_workflow_source(workflow: Workflow) -> None:
    """Reject a run when its canonical YAML source changed after loading."""

    if workflow.source_path is None or not workflow.source_sha256:
        return
    try:
        current = hashlib.sha256(workflow.source_path.read_bytes()).hexdigest()
    except OSError as exc:
        raise WorkflowSchemaError(
            f"workflow source is unavailable: {workflow.source_path}"
        ) from exc
    if current != workflow.source_sha256:
        raise WorkflowSchemaError(
            f"workflow source hash mismatch: {workflow.source_path}"
        )


def _to_step(raw_step: Mapping[str, Any]) -> Step:
    metadata = dict(raw_step.get("metadata") or {})
    provider = raw_step.get("provider")

    if provider is not None:
        metadata["provider"] = provider

    return Step(
        id=raw_step["id"],
        kind=parse_step_kind(raw_step["kind"], f"steps[{raw_step['id']}].kind"),
        name=raw_step.get("name") or raw_step["id"],
        needs=parse_needs(raw_step.get("needs"), f"steps[{raw_step['id']}].needs"),
        agent_id=raw_step.get("agent_id"),
        skill_id=raw_step.get("skill_id"),
        command=raw_step.get("command"),
        inputs=tuple(
            Path(path)
            for path in parse_string_paths(
                raw_step.get("inputs"), f"steps[{raw_step['id']}].inputs"
            )
        ),
        outputs=tuple(
            Path(path)
            for path in parse_string_paths(
                raw_step.get("outputs"), f"steps[{raw_step['id']}].outputs"
            )
        ),
        timeout_sec=raw_step.get("timeout_sec"),
        metadata=metadata,
    )


class _NoopStepRunner:
    """Only used to access RunnerEngine graph validation.

    It should never execute because `load_workflow_text()` calls `plan()`, not
    `run()`.
    """

    def run(self, step, context):  # pragma: no cover
        raise RuntimeError("_NoopStepRunner must not execute steps")
