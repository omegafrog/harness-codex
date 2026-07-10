from __future__ import annotations

import hashlib
from pathlib import Path
from xml.etree import ElementTree as ET

import pytest

from harness_codex.runtime.subagent_contract import (
    SubagentContractError,
    read_subagent_invocation,
    read_subagent_result,
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
    ET.SubElement(i, f"{{{NS.format('invocation')}}}inputs")
    inputs = list(i)[0]
    ET.SubElement(inputs, f"{{{NS.format('invocation')}}}artifact", {"path": "plan.md", "sha256": sha, "kind": "active-plan"})
    task = ET.SubElement(i, f"{{{NS.format('invocation')}}}reviewTask", {"profileId": "security-review"})
    criterion = ET.SubElement(task, f"{{{NS.format('invocation')}}}criterion", {"id": "SEC-001", "sourcePath": "plan.md", "sourceSha256": sha})
    ET.SubElement(criterion, f"{{{NS.format('invocation')}}}assertion").text = "boundary holds"
    r = ET.Element(f"{{{NS.format('result')}}}subagent-result")
    outcome = ET.SubElement(r, f"{{{NS.format('result')}}}outcome", {"status": "failed" if finding else "succeeded"})
    ET.SubElement(outcome, f"{{{NS.format('result')}}}summary").text = "checked"
    evidence = ET.SubElement(r, f"{{{NS.format('result')}}}evidence")
    ET.SubElement(evidence, f"{{{NS.format('result')}}}item", {"id": "e-1", "path": "plan.md"})
    review = ET.SubElement(r, f"{{{NS.format('result')}}}review")
    coverage = ET.SubElement(review, f"{{{NS.format('result')}}}coverage")
    ET.SubElement(coverage, f"{{{NS.format('result')}}}assessed", {"criterionRef": assessed, "evidenceRef": "e-1"})
    findings = ET.SubElement(review, f"{{{NS.format('result')}}}findings")
    if finding:
        node = ET.SubElement(findings, f"{{{NS.format('result')}}}finding", {"criterionRef": "SEC-001", "severity": "blocking", "evidenceRef": "e-1"})
        ET.SubElement(node, f"{{{NS.format('result')}}}message").text = "missing boundary"
    return i, r


def test_review_contract_accepts_complete_coverage_and_finding(tmp_path: Path) -> None:
    invocation, result = _tree(tmp_path, finding=True)
    validate_review_contract(invocation, result, tmp_path)


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
    list(result)[0].set("status", "succeeded")
    with pytest.raises(SubagentContractError, match="blocking finding"):
        validate_review_contract(invocation, result, tmp_path)
