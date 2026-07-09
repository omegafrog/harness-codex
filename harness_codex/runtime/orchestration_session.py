"""Agent-callable workflow orchestration session helpers.

The workflow_orchestrator agent owns progression. It reads a session JSON file and
uses this module's CLI to execute exactly one selected step at a time. Each
selected step may create a specialist agent, run a validator command, or perform
a git boundary action, then emits a structured StepResult for the orchestrator
agent to inspect before choosing the next step.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)
from harness_codex.runtime.runner import BasicStepRunner, StepRunner

SESSION_SCHEMA_VERSION = 1


def write_orchestration_session(workflow: Workflow, context: RunContext, path: Path) -> Path:
    """Write the session file consumed by workflow_orchestrator."""

    path.parent.mkdir(parents=True, exist_ok=True)
    relative_path = _display_path(path, context.repo_root)
    payload = {
        "schema_version": SESSION_SCHEMA_VERSION,
        "contract": {
            "progress_owner": "workflow_orchestrator_agent",
            "runtime_role": "single_step_executor",
            "step_execution_command": (
                "python3 -m harness_codex.runtime.orchestration_session run "
                f"--session {relative_path} --step-id <STEP-ID>"
            ),
        },
        "context": _context_to_dict(context),
        "workflow": _workflow_to_dict(workflow),
    }
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def execute_orchestrated_step(
    session_path: Path,
    step_id: str,
    *,
    completed_step_ids: tuple[str, ...] = (),
    enforce_needs: bool = True,
    step_runner: StepRunner | None = None,
) -> StepResult:
    """Execute one orchestrator-selected step from a persisted session."""

    payload = _read_session(session_path)
    workflow = _workflow_from_dict(payload["workflow"])
    context = _context_from_dict(payload["context"])
    engine = RunnerEngine(step_runner or BasicStepRunner())
    return engine.run_step(
        workflow,
        context,
        step_id,
        completed_step_ids=completed_step_ids,
        enforce_needs=enforce_needs,
    )


def step_result_to_dict(result: StepResult) -> dict[str, Any]:
    return {
        "step_id": result.step_id,
        "status": result.status.value,
        "exit_code": result.exit_code,
        "output_path": str(result.output_path) if result.output_path else None,
        "error": result.error,
        "failure_kind": result.failure_kind.value if result.failure_kind else None,
        "metadata": _jsonable(dict(result.metadata)),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python3 -m harness_codex.runtime.orchestration_session")
    subparsers = parser.add_subparsers(required=True)
    run = subparsers.add_parser("run", description="Execute one orchestrator-selected workflow step.")
    run.add_argument("--session", required=True, help="Path to orchestration session JSON.")
    run.add_argument("--step-id", required=True, help="Workflow step id to execute.")
    run.add_argument(
        "--completed-step",
        action="append",
        default=[],
        help="Previously completed prerequisite step id. May be repeated.",
    )
    run.add_argument(
        "--no-enforce-needs",
        action="store_true",
        help="Allow runtime remediation hooks to run even when normal prerequisites are not complete.",
    )
    args = parser.parse_args(argv)
    result = execute_orchestrated_step(
        _resolve_session_path(Path(args.session)),
        args.step_id,
        completed_step_ids=tuple(args.completed_step),
        enforce_needs=not args.no_enforce_needs,
    )
    print(json.dumps(step_result_to_dict(result), ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result.status in {StepStatus.SUCCEEDED, StepStatus.SKIPPED} else 1


def _read_session(path: Path) -> Mapping[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schema_version") != SESSION_SCHEMA_VERSION:
        raise ValueError(f"unsupported orchestration session schema: {payload.get('schema_version')}")
    if not isinstance(payload.get("workflow"), Mapping):
        raise ValueError("orchestration session is missing workflow")
    if not isinstance(payload.get("context"), Mapping):
        raise ValueError("orchestration session is missing context")
    return payload


def _context_to_dict(context: RunContext) -> dict[str, Any]:
    return {
        "run_id": context.run_id,
        "workflow_name": context.workflow_name,
        "mode": context.mode.value,
        "repo_root": str(context.repo_root),
        "workdir": str(context.workdir),
        "run_dir": str(context.run_dir),
        "active_plan_path": str(context.active_plan_path),
        "architecture_path": str(context.architecture_path),
        "metadata": _jsonable(dict(context.metadata)),
    }


def _context_from_dict(payload: Mapping[str, Any]) -> RunContext:
    return RunContext(
        run_id=str(payload["run_id"]),
        workflow_name=str(payload["workflow_name"]),
        mode=RunMode(str(payload["mode"])),
        repo_root=Path(str(payload["repo_root"])),
        workdir=Path(str(payload["workdir"])),
        run_dir=Path(str(payload["run_dir"])),
        active_plan_path=Path(str(payload.get("active_plan_path") or "docs/plans/active/plan.md")),
        architecture_path=Path(str(payload.get("architecture_path") or "ARCHITECTURE.md")),
        metadata=dict(payload.get("metadata") or {}),
    )


def _workflow_to_dict(workflow: Workflow) -> dict[str, Any]:
    return {
        "name": workflow.name,
        "mode": workflow.mode.value,
        "description": workflow.description,
        "metadata": _jsonable(dict(workflow.metadata)),
        "steps": [_step_to_dict(step) for step in workflow.steps],
    }


def _step_to_dict(step: Step) -> dict[str, Any]:
    return {
        "id": step.id,
        "kind": step.kind.value,
        "name": step.name,
        "needs": list(step.needs),
        "agent_id": step.agent_id,
        "skill_id": step.skill_id,
        "command": step.command,
        "inputs": [str(path) for path in step.inputs],
        "outputs": [str(path) for path in step.outputs],
        "timeout_sec": step.timeout_sec,
        "metadata": _jsonable(dict(step.metadata)),
    }


def _workflow_from_dict(payload: Mapping[str, Any]) -> Workflow:
    return Workflow(
        name=str(payload["name"]),
        mode=RunMode(str(payload["mode"])),
        description=payload.get("description") if isinstance(payload.get("description"), str) else None,
        metadata=dict(payload.get("metadata") or {}),
        steps=tuple(_step_from_dict(item) for item in payload.get("steps", ())),
    )


def _step_from_dict(payload: Mapping[str, Any]) -> Step:
    return Step(
        id=str(payload["id"]),
        kind=StepKind(str(payload["kind"])),
        name=str(payload.get("name") or payload["id"]),
        needs=tuple(str(value) for value in payload.get("needs", ())),
        agent_id=payload.get("agent_id") if isinstance(payload.get("agent_id"), str) else None,
        skill_id=payload.get("skill_id") if isinstance(payload.get("skill_id"), str) else None,
        command=payload.get("command") if isinstance(payload.get("command"), str) else None,
        inputs=tuple(Path(str(path)) for path in payload.get("inputs", ())),
        outputs=tuple(Path(str(path)) for path in payload.get("outputs", ())),
        timeout_sec=int(payload["timeout_sec"]) if payload.get("timeout_sec") is not None else None,
        metadata=dict(payload.get("metadata") or {}),
    )


def _resolve_session_path(path: Path) -> Path:
    return path if path.is_absolute() else Path.cwd() / path


def _display_path(path: Path, repo_root: Path) -> str:
    try:
        return str(path.relative_to(repo_root))
    except ValueError:
        return str(path)


def _jsonable(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, FailureKind):
        return value.value
    if isinstance(value, StepStatus):
        return value.value
    if hasattr(value, "value"):
        return value.value
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if hasattr(value, "__dataclass_fields__"):
        return _jsonable(asdict(value))
    return str(value)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
