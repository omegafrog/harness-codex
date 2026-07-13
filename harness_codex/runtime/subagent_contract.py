"""Canonical subagent v1 XML contract and semantic review validation."""

from __future__ import annotations

import hashlib
from pathlib import Path
from xml.etree import ElementTree as ET

INVOCATION_NS = "urn:harness:subagent-invocation:v1"
RESULT_NS = "urn:harness:subagent-result:v1"


class SubagentContractError(ValueError):
    """Raised when a subagent contract is malformed or internally inconsistent."""


def validate_subagent_handoff(
    invocation: ET.Element,
    result: ET.Element,
    *,
    run_id: str | None = None,
    step_id: str | None = None,
    agent_id: str | None = None,
    skill_id: str | None = None,
) -> None:
    """handoff identity/delegate 연속성 검증.

    Runtime은 deterministic fact만 검증한다. route 선택·결과 해석은
    orchestration agent 책임이다.
    """
    if invocation.tag != f"{{{INVOCATION_NS}}}subagent-invocation":
        raise SubagentContractError("invalid subagent invocation root")
    if result.tag != f"{{{RESULT_NS}}}subagent-result":
        raise SubagentContractError("invalid subagent result root")

    invocation_identity = _one(invocation, "identity")
    result_identity = _one(result, "identity")
    invocation_delegate = _one(invocation, "delegate")
    result_delegate = _one(result, "delegate")
    if invocation_identity is None or result_identity is None:
        raise SubagentContractError("invocation and result require identity")
    if invocation_delegate is None or result_delegate is None:
        raise SubagentContractError("invocation and result require delegate")

    identity_keys = ("runId", "stepId", "attemptId")
    delegate_keys = ("agentId", "skillId")
    for key in identity_keys:
        if not (invocation_identity.get(key, "").strip() and result_identity.get(key, "").strip()):
            raise SubagentContractError(f"missing required identity attribute: {key}")
        if invocation_identity.get(key) != result_identity.get(key):
            raise SubagentContractError(f"result identity mismatch: {key}")
    for key in delegate_keys:
        if not (invocation_delegate.get(key, "").strip() and result_delegate.get(key, "").strip()):
            raise SubagentContractError(f"missing required delegate attribute: {key}")
        if invocation_delegate.get(key) != result_delegate.get(key):
            raise SubagentContractError(f"result delegate mismatch: {key}")

    expected = {
        "runId": run_id,
        "stepId": step_id,
        "agentId": agent_id,
        "skillId": skill_id,
    }
    for key, value in expected.items():
        if value is not None and invocation_identity.get(key, invocation_delegate.get(key)) != value:
            raise SubagentContractError(f"invocation does not match selected {key}")

    instruction = _one(invocation, "instruction")
    outcome = _one(result, "outcome")
    if instruction is None or not (instruction.text or "").strip():
        raise SubagentContractError("invocation instruction is required")
    if outcome is None or not outcome.get("status", "").strip():
        raise SubagentContractError("result outcome status is required")


def write_subagent_invocation(path: Path, root: ET.Element) -> Path:
    return _write_xml(path, root, INVOCATION_NS, "subagent-invocation")


def read_subagent_invocation(path: Path) -> ET.Element:
    invocation = _read_xml(path, INVOCATION_NS, "subagent-invocation")
    _validate_invocation_shape(invocation)
    return invocation


def _validate_invocation_shape(invocation: ET.Element) -> None:
    names = [child.tag.rsplit("}", 1)[-1] for child in invocation]
    required = ["identity", "delegate", "instruction", "inputs"]
    if names[:4] != required or names[-1:] != ["result"]:
        raise SubagentContractError("invocation must use identity, delegate, instruction, inputs, optional reviewTask, result order")
    if any(name in {"inputArtifacts", "resultPath"} for name in names):
        raise SubagentContractError("legacy invocation elements are not allowed")


def write_subagent_result(path: Path, root: ET.Element) -> Path:
    return _write_xml(path, root, RESULT_NS, "subagent-result")


def read_subagent_result(path: Path) -> ET.Element:
    result = _read_xml(path, RESULT_NS, "subagent-result")
    _validate_result_shape(result)
    return result


def _validate_result_shape(result: ET.Element) -> None:
    names = [child.tag.rsplit("}", 1)[-1] for child in result]
    required = ["identity", "delegate", "outcome"]
    if names[:3] != required or names[-4:] != ["artifacts", "evidence", "changes", "blockers"]:
        raise SubagentContractError("result must use identity, delegate, outcome, optional review/verification, artifacts, evidence, changes, blockers order")
    if names.count("review") > 1 or names.count("verification") > 1:
        raise SubagentContractError("result review and verification are optional singleton elements")
    for name in ("artifacts", "changes", "blockers"):
        element = _one(result, name)
        if element is not None and (list(element) or (element.text or "").strip()):
            raise SubagentContractError(f"result {name} must remain empty under v1")
    review = _one(result, "review")
    if review is not None:
        findings = _one(review, "findings")
        if findings is None:
            raise SubagentContractError("review requires findings")
        for finding in _many(findings, "finding"):
            messages = _many(finding, "message")
            if len(messages) != 1 or not (messages[0].text or "").strip():
                raise SubagentContractError("review finding requires one message")


def validate_review_contract(invocation: ET.Element, result: ET.Element, repo_root: Path) -> None:
    """Validate criterion coverage, references, outcome, and input artifact hashes."""
    task = _one(invocation, "reviewTask")
    review = _one(result, "review")
    if task is None:
        if review is not None:
            raise SubagentContractError("result contains review without invocation reviewTask")
        return
    if review is None:
        raise SubagentContractError("reviewTask requires result review")
    criteria = {_required(c, "id") for c in _many(task, "criterion")}
    coverage = _one(review, "coverage")
    assessed = _many(coverage, "assessed")
    refs = [_required(item, "criterionRef") for item in assessed]
    if len(refs) != len(criteria) or set(refs) != criteria:
        raise SubagentContractError("review coverage must assess every criterion exactly once")
    evidence = {_required(item, "id") for item in _many(_one(result, "evidence"), "item")}
    for item in assessed:
        if _required(item, "evidenceRef") not in evidence:
            raise SubagentContractError("coverage references unknown evidence")
    findings = _many(_one(review, "findings"), "finding")
    for item in findings:
        if _required(item, "criterionRef") not in criteria:
            raise SubagentContractError("finding references criterion outside invocation")
        if _required(item, "evidenceRef") not in evidence:
            raise SubagentContractError("finding references unknown evidence")
    if any(item.get("severity") == "blocking" for item in findings) and _required(_one(result, "outcome"), "status") == "succeeded":
        raise SubagentContractError("blocking finding cannot have succeeded outcome")
    for artifact in _many(_one(invocation, "inputs"), "artifact"):
        path = repo_root / _required(artifact, "path")
        if not path.is_file():
            raise SubagentContractError(f"input artifact is missing: {path}")
        if _sha256(path) != _required(artifact, "sha256"):
            raise SubagentContractError(f"input artifact hash mismatch: {path}")
    for criterion in _many(task, "criterion"):
        source = repo_root / _required(criterion, "sourcePath")
        if not source.is_file() or _sha256(source) != _required(criterion, "sourceSha256"):
            raise SubagentContractError(f"criterion source hash mismatch: {source}")


def _many(parent: ET.Element | None, name: str) -> list[ET.Element]:
    if parent is None:
        return []
    return [child for child in parent if child.tag.rsplit("}", 1)[-1] == name]


def _one(parent: ET.Element | None, name: str) -> ET.Element | None:
    values = _many(parent, name)
    return values[0] if values else None


def _required(element: ET.Element | None, name: str) -> str:
    if element is None or not (value := element.get(name, "").strip()):
        raise SubagentContractError(f"missing required attribute: {name}")
    return value


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_xml(path: Path, root: ET.Element, namespace: str, local_name: str) -> Path:
    if root.tag != f"{{{namespace}}}{local_name}":
        raise SubagentContractError(f"expected {local_name} root")
    ET.indent(root, space="  ")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(ET.tostring(root, encoding="utf-8", xml_declaration=True))
    return path


def _read_xml(path: Path, namespace: str, local_name: str) -> ET.Element:
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as exc:
        raise SubagentContractError(f"invalid {local_name} XML: {path}") from exc
    if root.tag != f"{{{namespace}}}{local_name}" or root.get("schemaVersion") != "1":
        raise SubagentContractError(f"invalid {local_name} contract")
    return root
