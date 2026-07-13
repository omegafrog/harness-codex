"""Runtime-owned execution of one orchestrator-selected specialist step."""

from __future__ import annotations

import argparse
import hashlib
import tomllib
from datetime import datetime
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

from harness_codex.runtime.agent_session import AgentSessionAdapter, AgentSessionRequest, CliAgentSessionAdapter
from harness_codex.runtime.subagent_contract import (
    INVOCATION_NS,
    RESULT_NS,
    SubagentContractError,
    read_subagent_invocation,
    read_subagent_result,
    validate_review_contract,
    validate_subagent_handoff,
    write_subagent_invocation,
    write_subagent_result,
)
from harness_codex.runtime.workflows.loader import load_workflow_file

_PENDING = "runtime scaffold pending specialist completion"


@dataclass(frozen=True)
class SpecialistDispatchResult:
    status: str
    fact: str
    message: str
    invocation_path: Path
    result_path: Path


def dispatch_specialist(*, repo_root: Path | str, run_id: str, step_id: str, change_set_id: str = "", work_item_id: str = "", session_adapter: AgentSessionAdapter | None = None) -> SpecialistDispatchResult:
    """Run only the selected agent step. Route decisions stay with the parent."""
    root = Path(repo_root).resolve()
    workflow = load_workflow_file(root / ".harness/workflows/changeset-use-case-workflow.yaml")
    step = workflow.step_by_id(step_id)
    if step is None or step.kind.value != "agent" or not step.agent_id or not step.skill_id:
        raise ValueError(f"selected step is not dispatchable agent step: {step_id}")
    step_dir = root / ".harness/runs" / run_id / "steps" / step_id
    invocation_path = step_dir / "subagent-invocation.xml"
    result_path = step_dir / "subagent-result.xml"
    inputs = _resolve_inputs(root, step.inputs, change_set_id, work_item_id, run_id)
    if not inputs:
        return SpecialistDispatchResult("blocked", "missing_declared_input", step_id, invocation_path, result_path)
    instruction = _step_instruction(root, run_id, step_id)
    invocation = _invocation(root, run_id, step_id, f"attempt-{1 + int(result_path.exists())}", step.agent_id, step.skill_id, inputs, result_path, instruction)
    write_subagent_invocation(invocation_path, invocation)
    read_subagent_invocation(invocation_path)
    _write_result_scaffold(result_path, invocation, inputs)

    config_path = root / ".codex/agents" / f"{step.agent_id}.toml"
    skill_path = root / ".codex/skills" / step.skill_id / "SKILL.md"
    if not config_path.is_file() or not skill_path.is_file():
        return SpecialistDispatchResult("blocked", "missing_specialist_control_plane", step_id, invocation_path, result_path)
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))
    skill = skill_path.read_text(encoding="utf-8")
    prompt = _specialist_prompt(
        invocation_path=invocation_path,
        result_path=result_path,
        agent_instruction=str(config["developer_instructions"]),
        skill=skill,
    )
    (step_dir / "prompt.md").write_text(prompt, encoding="utf-8")
    provider = (session_adapter or CliAgentSessionAdapter()).run(AgentSessionRequest(
        repo_root=root, session_dir=step_dir, agent_config_path=config_path, agent_config=config,
        prompt=prompt, timeout_sec=step.timeout_sec or 1800, specialist_run_id=run_id,
        verification_observation_budget_sec=(int(step.metadata["verification_observation_budget_sec"]) if step.agent_id == "implementation_executor" and step.metadata.get("verification_observation_budget_sec") else None),
    ))
    if provider.status != "succeeded":
        fact = "verification_root_cause" if provider.termination_reason == "verification_observation_timeout" else "specialist_provider_failure"
        return SpecialistDispatchResult(provider.status, fact, provider.error or provider.termination_reason, invocation_path, result_path)
    try:
        result = read_subagent_result(result_path)
        _validate_scaffold_completion(invocation, result)
        validate_subagent_handoff(invocation, result, run_id=run_id, step_id=step_id, agent_id=step.agent_id, skill_id=step.skill_id)
        validate_review_contract(invocation, result, root)
    except SubagentContractError as exc:
        return SpecialistDispatchResult("blocked", "subagent_protocol_failure", str(exc), invocation_path, result_path)
    outcome = result.find(f"{{{RESULT_NS}}}outcome")
    raw_status = outcome.get("status", "blocked")
    # subagent-result uses `completed` for a completed specialist task, while
    # workflow dependencies use the runtime StepStatus vocabulary.  Normalize
    # at this boundary without rewriting the established XML contract.
    status = _workflow_status(raw_status)
    fact = "review_rejected" if step.agent_id == "artifact_reviewer" and status == "blocked" else "specialist_result"
    return SpecialistDispatchResult(status, fact, "", invocation_path, result_path)


def _workflow_status(status: str) -> str:
    return "succeeded" if status == "completed" else status


def _resolve_inputs(root: Path, raw_inputs: tuple[Path, ...], change_set_id: str, work_item_id: str, run_id: str) -> list[Path]:
    values = {"<CHG-ID>": change_set_id, "<WORK-ITEM-ID>": work_item_id, "<MAINT-ID>": work_item_id, "<RUN-ID>": run_id}
    found: list[Path] = []
    for raw in raw_inputs:
        text = str(raw)
        for token, value in values.items():
            text = text.replace(token, value)
        path = root / text
        if path.is_file():
            found.append(path)
    return found


def _invocation(root: Path, run_id: str, step_id: str, attempt_id: str, agent_id: str, skill_id: str, inputs: list[Path], result_path: Path, instruction: str) -> ET.Element:
    document = ET.Element(f"{{{INVOCATION_NS}}}subagent-invocation", {"schemaVersion": "1"})
    ET.SubElement(document, f"{{{INVOCATION_NS}}}identity", {"runId": run_id, "stepId": step_id, "attemptId": attempt_id})
    ET.SubElement(document, f"{{{INVOCATION_NS}}}delegate", {"agentId": agent_id, "skillId": skill_id})
    ET.SubElement(document, f"{{{INVOCATION_NS}}}instruction").text = instruction
    artifacts = ET.SubElement(document, f"{{{INVOCATION_NS}}}inputs")
    for path in inputs:
        ET.SubElement(artifacts, f"{{{INVOCATION_NS}}}artifact", {"kind": "document", "path": str(path.relative_to(root)), "sha256": _sha(path)})
    if agent_id == "artifact_reviewer":
        review = ET.SubElement(document, f"{{{INVOCATION_NS}}}reviewTask", {"profileId": "declared-artifact-review"})
        for index, path in enumerate(inputs, start=1):
            criterion = ET.SubElement(review, f"{{{INVOCATION_NS}}}criterion", {"id": f"input-{index}", "sourcePath": str(path.relative_to(root)), "sourceSha256": _sha(path)})
            ET.SubElement(criterion, f"{{{INVOCATION_NS}}}assertion").text = "Assess this declared artifact only."
    ET.SubElement(document, f"{{{INVOCATION_NS}}}result", {"path": str(result_path.relative_to(root))})
    return document


def _step_instruction(root: Path, run_id: str, step_id: str) -> str:
    base = f"Execute selected workflow step {step_id} using declared artifacts only."
    if step_id != "create-change-set":
        return base
    request_path = root / ".harness/orchestration" / run_id / "request.json"
    try:
        import json

        instruction = str(json.loads(request_path.read_text(encoding="utf-8")).get("instruction") or "").strip()
    except (OSError, ValueError, TypeError):
        instruction = ""
    change_set_id = _next_change_set_id(root)
    return f"{base} Create active ChangeSet ID {change_set_id} from this original user instruction: {instruction}" if instruction else base


def _next_change_set_id(root: Path) -> str:
    prefix = f"CHG-{datetime.now().strftime('%Y%m%d')}-"
    existing = {
        path.stem
        for directory in (root / "docs/changes/active", root / "docs/changes/completed")
        if directory.is_dir()
        for path in directory.glob(f"{prefix}*.md")
    }
    number = 1
    while f"{prefix}{number:03d}" in existing:
        number += 1
    return f"{prefix}{number:03d}"


def _write_result_scaffold(path: Path, invocation: ET.Element, inputs: list[Path]) -> None:
    identity = invocation.find(f"{{{INVOCATION_NS}}}identity")
    delegate = invocation.find(f"{{{INVOCATION_NS}}}delegate")
    result = ET.Element(f"{{{RESULT_NS}}}subagent-result", {"schemaVersion": "1"})
    ET.SubElement(result, f"{{{RESULT_NS}}}identity", dict(identity.attrib))
    ET.SubElement(result, f"{{{RESULT_NS}}}delegate", dict(delegate.attrib))
    outcome = ET.SubElement(result, f"{{{RESULT_NS}}}outcome", {"status": "blocked"})
    ET.SubElement(outcome, f"{{{RESULT_NS}}}summary").text = _PENDING
    task = invocation.find(f"{{{INVOCATION_NS}}}reviewTask")
    if task is not None:
        review = ET.SubElement(result, f"{{{RESULT_NS}}}review")
        coverage = ET.SubElement(review, f"{{{RESULT_NS}}}coverage")
        for index, criterion in enumerate(task.findall(f"{{{INVOCATION_NS}}}criterion"), start=1):
            ET.SubElement(coverage, f"{{{RESULT_NS}}}assessed", {"criterionRef": criterion.get("id"), "evidenceRef": f"input-{index}"})
        ET.SubElement(review, f"{{{RESULT_NS}}}findings")
    ET.SubElement(result, f"{{{RESULT_NS}}}artifacts")
    evidence = ET.SubElement(result, f"{{{RESULT_NS}}}evidence")
    for index, path_value in enumerate(inputs, start=1):
        ET.SubElement(evidence, f"{{{RESULT_NS}}}item", {"id": f"input-{index}", "path": str(path_value)})
    ET.SubElement(result, f"{{{RESULT_NS}}}changes")
    ET.SubElement(result, f"{{{RESULT_NS}}}blockers")
    write_subagent_result(path, result)


def _validate_scaffold_completion(invocation: ET.Element, result: ET.Element) -> None:
    summary = result.findtext(f"{{{RESULT_NS}}}outcome/{{{RESULT_NS}}}summary", default="").strip()
    if summary == _PENDING:
        raise SubagentContractError("specialist did not complete result scaffold")
    task = invocation.find(f"{{{INVOCATION_NS}}}reviewTask")
    if task is None:
        return
    expected = [criterion.get("id") for criterion in task.findall(f"{{{INVOCATION_NS}}}criterion")]
    actual = [item.get("criterionRef") for item in result.findall(f"{{{RESULT_NS}}}review/{{{RESULT_NS}}}coverage/{{{RESULT_NS}}}assessed")]
    if actual != expected:
        raise SubagentContractError("review result scaffold coverage was modified")


def _specialist_prompt(*, invocation_path: Path, result_path: Path, agent_instruction: str, skill: str) -> str:
    return "\n".join((
        "<agent_instruction>", agent_instruction.strip(), "</agent_instruction>",
        "<skill_sequence>", skill.strip(), "</skill_sequence>",
        f"invocation_path: {invocation_path}", f"result_path: {result_path}",
        "Runtime created the existing v1 result scaffold. Do not read agent, skill, prior-run, or undeclared files.",
        "Edit only declared result values; preserve scaffold identity, delegate, review coverage, and evidence IDs.",
        "For each review finding use exactly `<finding criterionRef=\"input-N\" severity=\"blocking\" evidenceRef=\"input-N\"><message>...</message></finding>`; keep artifacts, changes, and blockers empty.",
        "Return after result XML completion.",
    ))


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--step-id", required=True)
    parser.add_argument("--change-set-id", required=True)
    parser.add_argument("--work-item-id", required=True)
    args = parser.parse_args(argv)
    value = dispatch_specialist(repo_root=args.repo_root, run_id=args.run_id, step_id=args.step_id, change_set_id=args.change_set_id, work_item_id=args.work_item_id)
    print(f"status={value.status}\nfact={value.fact}\nmessage={value.message}\ninvocation={value.invocation_path}\nresult={value.result_path}")
    return 0 if value.status == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
