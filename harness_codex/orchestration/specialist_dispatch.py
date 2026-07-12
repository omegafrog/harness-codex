"""Runtime-owned specialist dispatch for one orchestrator-selected workflow step."""

from __future__ import annotations

import argparse
import hashlib
import tomllib
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

from harness_codex.runtime.agent_session import AgentSessionAdapter, AgentSessionRequest, CliAgentSessionAdapter
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.subagent_contract import (
    INVOCATION_NS,
    SubagentContractError,
    read_subagent_invocation,
    read_subagent_result,
    validate_review_contract,
    validate_subagent_handoff,
    write_subagent_invocation,
)
from harness_codex.runtime.workflows.loader import load_workflow_file


@dataclass(frozen=True)
class SpecialistDispatchResult:
    status: str
    message: str
    invocation_path: Path
    result_path: Path


def dispatch_specialist(
    *,
    repo_root: Path | str,
    run_id: str,
    step_id: str,
    change_set_id: str,
    work_item_id: str,
    session_adapter: AgentSessionAdapter | None = None,
) -> SpecialistDispatchResult:
    """Execute exactly one pre-selected agent step; never choose or route a step."""

    root = Path(repo_root).resolve()
    workflow = load_workflow_file(root / ".harness/workflows/changeset-use-case-workflow.yaml")
    step = workflow.step_by_id(step_id)
    if step is None or step.kind.value != "agent" or not step.agent_id or not step.skill_id:
        raise ValueError(f"selected step is not dispatchable agent step: {step_id}")

    step_dir = root / ".harness/runs" / run_id / "steps" / step_id
    result_path = step_dir / "subagent-result.xml"
    invocation_path = step_dir / "subagent-invocation.xml"
    inputs = _resolve_inputs(root, step.inputs, change_set_id, work_item_id, run_id)
    if not inputs:
        raise ValueError(f"selected step has no file artifact inputs: {step_id}")
    attempt_id = f"attempt-{1 + int(result_path.exists())}"
    invocation = _invocation(
        root=root,
        run_id=run_id,
        step_id=step_id,
        attempt_id=attempt_id,
        agent_id=step.agent_id,
        skill_id=step.skill_id,
        inputs=inputs,
        result_path=result_path,
    )
    write_subagent_invocation(invocation_path, invocation)
    read_subagent_invocation(invocation_path)

    config_path = root / ".codex/agents" / f"{step.agent_id}.toml"
    skill_path = root / ".codex/skills" / step.skill_id / "SKILL.md"
    if not config_path.is_file() or not skill_path.is_file():
        raise ValueError(f"missing specialist control plane: {config_path} / {skill_path}")
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    prompt = "\n".join((
        "You are a runtime-dispatched specialist. Do not route, spawn agents, or choose another workflow step.",
        f"Read only this selected agent profile: {config_path}",
        f"Then read only this selected skill sequence: {skill_path}",
        f"Execute this existing v1 invocation: {invocation_path}",
        f"Write exactly one matching v1 result XML: {result_path}",
        "Return after the XML is written. Do not create JSON handoffs or substitute reports.",
    ))
    provider = (session_adapter or CliAgentSessionAdapter()).run(
        AgentSessionRequest(
            repo_root=root,
            session_dir=step_dir,
            agent_config_path=config_path,
            agent_config=config,
            prompt=prompt,
            timeout_sec=step.timeout_sec or 1800,
        )
    )
    if provider.status != "succeeded":
        return SpecialistDispatchResult(provider.status, provider.error or provider.termination_reason, invocation_path, result_path)
    try:
        result = read_subagent_result(result_path)
        validate_subagent_handoff(invocation, result, run_id=run_id, step_id=step_id, agent_id=step.agent_id, skill_id=step.skill_id)
        validate_review_contract(invocation, result, root)
    except SubagentContractError as exc:
        return SpecialistDispatchResult("blocked", f"subagent contract failure: {exc}", invocation_path, result_path)
    return SpecialistDispatchResult(result.find(f"{{{INVOCATION_NS.replace('invocation', 'result')}}}outcome").get("status", "blocked"), "", invocation_path, result_path)


def _resolve_inputs(root: Path, raw_inputs: tuple[Path, ...], change_set_id: str, work_item_id: str, run_id: str) -> list[Path]:
    replacements = {"<CHG-ID>": change_set_id, "<WORK-ITEM-ID>": work_item_id, "<MAINT-ID>": work_item_id, "<RUN-ID>": run_id}
    resolved: list[Path] = []
    for raw in raw_inputs:
        value = str(raw)
        for token, replacement in replacements.items():
            value = value.replace(token, replacement)
        path = root / value
        if path.is_file():
            resolved.append(path)
    return resolved


def _invocation(*, root: Path, run_id: str, step_id: str, attempt_id: str, agent_id: str, skill_id: str, inputs: list[Path], result_path: Path) -> ET.Element:
    root_element = ET.Element(f"{{{INVOCATION_NS}}}subagent-invocation", {"schemaVersion": "1"})
    ET.SubElement(root_element, f"{{{INVOCATION_NS}}}identity", {"runId": run_id, "stepId": step_id, "attemptId": attempt_id})
    ET.SubElement(root_element, f"{{{INVOCATION_NS}}}delegate", {"agentId": agent_id, "skillId": skill_id})
    ET.SubElement(root_element, f"{{{INVOCATION_NS}}}instruction").text = f"Execute workflow step {step_id} with the declared artifacts only."
    artifacts = ET.SubElement(root_element, f"{{{INVOCATION_NS}}}inputs")
    for path in inputs:
        ET.SubElement(artifacts, f"{{{INVOCATION_NS}}}artifact", {"kind": "document", "path": str(path.relative_to(root)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    if agent_id == "artifact_reviewer":
        source = inputs[-1]
        task = ET.SubElement(root_element, f"{{{INVOCATION_NS}}}reviewTask", {"profileId": "workflow-step-review"})
        criterion = ET.SubElement(task, f"{{{INVOCATION_NS}}}criterion", {"id": "declared-scope", "sourcePath": str(source.relative_to(root)), "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest()})
        ET.SubElement(criterion, f"{{{INVOCATION_NS}}}assertion").text = "Assess only the declared workflow artifact and its stated scope."
    ET.SubElement(root_element, f"{{{INVOCATION_NS}}}result", {"path": str(result_path.relative_to(root))})
    return root_element


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--step-id", required=True)
    parser.add_argument("--change-set-id", required=True)
    parser.add_argument("--work-item-id", required=True)
    args = parser.parse_args(argv)
    result = dispatch_specialist(repo_root=args.repo_root, run_id=args.run_id, step_id=args.step_id, change_set_id=args.change_set_id, work_item_id=args.work_item_id)
    print(f"status={result.status}\ninvocation={result.invocation_path}\nresult={result.result_path}\nmessage={result.message}")
    return 0 if result.status == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
