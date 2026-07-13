from __future__ import annotations

import hashlib
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

from harness_codex.runtime.subagent_contract import (
    SubagentContractError,
    read_subagent_invocation,
    read_subagent_result,
    validate_subagent_handoff,
    validate_review_contract,
    write_subagent_invocation,
    write_subagent_result,
)


NS = "urn:harness:subagent-{}:v1"


def _tree(tmp_path: Path, *, assessed: str = "SEC-001", finding: bool = False) -> tuple[ET.Element, ET.Element]:
    artifact = tmp_path / "plan.md"
    artifact.write_text("plan", encoding="utf-8")
    sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
    i = ET.Element(f"{{{NS.format('invocation')}}}subagent-invocation")
    ET.SubElement(i, f"{{{NS.format('invocation')}}}identity", {"runId": "run-1", "stepId": "execute", "attemptId": "attempt-1"})
    ET.SubElement(i, f"{{{NS.format('invocation')}}}delegate", {"agentId": "implementation_executor", "skillId": "harness-implementation-executor"})
    ET.SubElement(i, f"{{{NS.format('invocation')}}}instruction").text = "execute task"
    ET.SubElement(i, f"{{{NS.format('invocation')}}}inputs")
    inputs = list(i)[0]
    ET.SubElement(inputs, f"{{{NS.format('invocation')}}}artifact", {"path": "plan.md", "sha256": sha, "kind": "active-plan"})
    task = ET.SubElement(i, f"{{{NS.format('invocation')}}}reviewTask", {"profileId": "security-review"})
    criterion = ET.SubElement(task, f"{{{NS.format('invocation')}}}criterion", {"id": "SEC-001", "sourcePath": "plan.md", "sourceSha256": sha})
    ET.SubElement(criterion, f"{{{NS.format('invocation')}}}assertion").text = "boundary holds"
    ET.SubElement(i, f"{{{NS.format('invocation')}}}result", {"path": ".harness/runs/run-1/steps/execute/subagent-result.xml"})
    r = ET.Element(f"{{{NS.format('result')}}}subagent-result")
    ET.SubElement(r, f"{{{NS.format('result')}}}identity", {"runId": "run-1", "stepId": "execute", "attemptId": "attempt-1"})
    ET.SubElement(r, f"{{{NS.format('result')}}}delegate", {"agentId": "implementation_executor", "skillId": "harness-implementation-executor"})
    outcome = ET.SubElement(r, f"{{{NS.format('result')}}}outcome", {"status": "failed" if finding else "succeeded"})
    ET.SubElement(outcome, f"{{{NS.format('result')}}}summary").text = "checked"
    review = ET.SubElement(r, f"{{{NS.format('result')}}}review")
    coverage = ET.SubElement(review, f"{{{NS.format('result')}}}coverage")
    ET.SubElement(coverage, f"{{{NS.format('result')}}}assessed", {"criterionRef": assessed, "evidenceRef": "e-1"})
    findings = ET.SubElement(review, f"{{{NS.format('result')}}}findings")
    if finding:
        node = ET.SubElement(findings, f"{{{NS.format('result')}}}finding", {"criterionRef": "SEC-001", "severity": "blocking", "evidenceRef": "e-1"})
        ET.SubElement(node, f"{{{NS.format('result')}}}message").text = "missing boundary"
    ET.SubElement(r, f"{{{NS.format('result')}}}artifacts")
    evidence = ET.SubElement(r, f"{{{NS.format('result')}}}evidence")
    ET.SubElement(evidence, f"{{{NS.format('result')}}}item", {"id": "e-1", "path": "plan.md"})
    ET.SubElement(r, f"{{{NS.format('result')}}}changes")
    ET.SubElement(r, f"{{{NS.format('result')}}}blockers")
    return i, r


def test_review_contract_accepts_complete_coverage_and_finding(tmp_path: Path) -> None:
    invocation, result = _tree(tmp_path, finding=True)
    validate_review_contract(invocation, result, tmp_path)


def test_handoff_requires_matching_identity_and_delegate(tmp_path: Path) -> None:
    invocation, result = _tree(tmp_path)
    validate_subagent_handoff(
        invocation,
        result,
        run_id="run-1",
        step_id="execute",
        agent_id="implementation_executor",
        skill_id="harness-implementation-executor",
    )

    result.find(f"{{{NS.format('result')}}}delegate").set("skillId", "wrong-skill")  # type: ignore[union-attr]
    with pytest.raises(SubagentContractError, match="delegate mismatch"):
        validate_subagent_handoff(invocation, result)


def test_subagent_xml_round_trip_preserves_canonical_roots(tmp_path: Path) -> None:
    invocation, result = _tree(tmp_path)
    invocation.set("schemaVersion", "1")
    result.set("schemaVersion", "1")
    invocation_path = write_subagent_invocation(tmp_path / "invocation.xml", invocation)
    result_path = write_subagent_result(tmp_path / "result.xml", result)

    assert read_subagent_invocation(invocation_path).tag.endswith("subagent-invocation")
    assert read_subagent_result(result_path).tag.endswith("subagent-result")


def test_review_contract_rejects_unknown_criterion_reference(tmp_path: Path) -> None:
    invocation, result = _tree(tmp_path, assessed="SEC-999")
    with pytest.raises(SubagentContractError, match="every criterion"):
        validate_review_contract(invocation, result, tmp_path)


def test_review_contract_rejects_blocking_finding_with_success(tmp_path: Path) -> None:
    invocation, result = _tree(tmp_path, finding=True)
    result.find(f"{{{NS.format('result')}}}outcome").set("status", "succeeded")  # type: ignore[union-attr]
    with pytest.raises(SubagentContractError, match="blocking finding"):
        validate_review_contract(invocation, result, tmp_path)


def test_result_contract_rejects_non_v1_finding_and_blocker_shape(tmp_path: Path) -> None:
    _, result = _tree(tmp_path)
    findings = result.find(f"{{{NS.format('result')}}}review/{{{NS.format('result')}}}findings")
    finding = ET.SubElement(findings, f"{{{NS.format('result')}}}finding", {"criterionRef": "SEC-001", "severity": "blocking", "evidenceRef": "e-1"})
    ET.SubElement(finding, f"{{{NS.format('result')}}}summary").text = "wrong"
    result.set("schemaVersion", "1")
    path = write_subagent_result(tmp_path / "bad-result.xml", result)

    with pytest.raises(SubagentContractError, match="requires one message"):
        read_subagent_result(path)
