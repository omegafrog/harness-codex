"""Runtime tool XML request/result contract."""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping
from xml.etree import ElementTree as ET


NAMESPACE = "urn:harness:runtime-tool:v1"
SCHEMA_VERSION = "1"
_FORBIDDEN_RESULT_KEYS = frozenset(
    {"next_step", "retry", "repair_target", "workflow_route", "owner_stage", "resume_target"}
)
ET.register_namespace("", NAMESPACE)


class RuntimeToolContractError(ValueError):
    """Raised when runtime tool XML is malformed or violates contract."""


@dataclass(frozen=True)
class RuntimeToolRequest:
    request_id: str
    tool_id: str
    operation: str
    repo_root: Path
    input: Mapping[str, Any] = field(default_factory=dict)
    run_id: str = ""
    work_item_id: str = ""


@dataclass(frozen=True)
class RuntimeToolResult:
    request_id: str
    tool_id: str
    status: str
    output: Any = field(default_factory=dict)
    error_code: str = ""
    error_message: str = ""
    evidence: tuple[str, ...] = ()


def request_to_xml(request: RuntimeToolRequest) -> bytes:
    _validate_request(request)
    root = ET.Element(
        _tag("runtime-tool-request"),
        {
            "schemaVersion": SCHEMA_VERSION,
            "requestId": request.request_id,
            "toolId": request.tool_id,
            "operation": request.operation,
        },
    )
    ET.SubElement(
        root,
        _tag("context"),
        {
            "repoRoot": str(request.repo_root),
            **({"runId": request.run_id} if request.run_id else {}),
            **({"workItemId": request.work_item_id} if request.work_item_id else {}),
        },
    )
    input_node = ET.SubElement(root, _tag("input"))
    _append_value(input_node, dict(request.input))
    return _serialize(root)


def request_from_xml(source: bytes | str | Path | ET.Element) -> RuntimeToolRequest:
    root = _parse_source(source)
    if root.tag != _tag("runtime-tool-request"):
        raise RuntimeToolContractError("request root must be runtime-tool-request")
    _validate_root_attributes(root, ("requestId", "toolId", "operation"))
    children = list(root)
    if len(children) != 2 or _local(children[0]) != "context" or _local(children[1]) != "input":
        raise RuntimeToolContractError("request requires context followed by input")
    context = children[0]
    repo_root = context.get("repoRoot", "").strip()
    if not repo_root:
        raise RuntimeToolContractError("request context requires repoRoot")
    payload = _read_single_value(children[1])
    if not isinstance(payload, dict):
        raise RuntimeToolContractError("request input must be a map")
    return RuntimeToolRequest(
        request_id=root.get("requestId", ""),
        tool_id=root.get("toolId", ""),
        operation=root.get("operation", ""),
        repo_root=Path(repo_root),
        input=payload,
        run_id=context.get("runId", ""),
        work_item_id=context.get("workItemId", ""),
    )


def result_to_xml(result: RuntimeToolResult) -> bytes:
    _validate_result(result)
    root = ET.Element(
        _tag("runtime-tool-result"),
        {
            "schemaVersion": SCHEMA_VERSION,
            "requestId": result.request_id,
            "toolId": result.tool_id,
            "status": result.status,
        },
    )
    output = ET.SubElement(root, _tag("output"))
    _append_value(output, result.output)
    if result.error_code or result.error_message:
        error = ET.SubElement(root, _tag("error"), {"code": result.error_code or "runtime-error"})
        error.text = result.error_message
    evidence = ET.SubElement(root, _tag("evidence"))
    for path in result.evidence:
        ET.SubElement(evidence, _tag("path")).text = path
    return _serialize(root)


def result_from_xml(source: bytes | str | Path | ET.Element) -> RuntimeToolResult:
    root = _parse_source(source)
    if root.tag != _tag("runtime-tool-result"):
        raise RuntimeToolContractError("result root must be runtime-tool-result")
    _validate_root_attributes(root, ("requestId", "toolId", "status"))
    if root.get("status") not in {"completed", "failed", "blocked"}:
        raise RuntimeToolContractError("result status must be completed, failed, or blocked")
    children = list(root)
    if not children or _local(children[0]) != "output":
        raise RuntimeToolContractError("result requires output")
    output = _read_single_value(children[0])
    error_node = next((item for item in children[1:] if _local(item) == "error"), None)
    evidence_node = next((item for item in children[1:] if _local(item) == "evidence"), None)
    unknown = [_local(item) for item in children[1:] if _local(item) not in {"error", "evidence"}]
    if unknown:
        raise RuntimeToolContractError(f"unknown result elements: {', '.join(unknown)}")
    evidence = tuple(
        (item.text or "")
        for item in (list(evidence_node) if evidence_node is not None else [])
        if _local(item) == "path"
    )
    return RuntimeToolResult(
        request_id=root.get("requestId", ""),
        tool_id=root.get("toolId", ""),
        status=root.get("status", ""),
        output=output,
        error_code=error_node.get("code", "") if error_node is not None else "",
        error_message=error_node.text or "" if error_node is not None else "",
        evidence=evidence,
    )


def write_xml(path: Path | str, payload: bytes) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".runtime-tool-", suffix=".xml", dir=target.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)
    return target


def _validate_request(request: RuntimeToolRequest) -> None:
    for name, value in (
        ("request_id", request.request_id),
        ("tool_id", request.tool_id),
        ("operation", request.operation),
    ):
        if not value.strip():
            raise RuntimeToolContractError(f"request {name} is required")
    if not str(request.repo_root).strip():
        raise RuntimeToolContractError("request repo_root is required")
    if not isinstance(request.input, Mapping):
        raise RuntimeToolContractError("request input must be a map")


def _validate_result(result: RuntimeToolResult) -> None:
    if not result.request_id.strip() or not result.tool_id.strip():
        raise RuntimeToolContractError("result request_id and tool_id are required")
    if result.status not in {"completed", "failed", "blocked"}:
        raise RuntimeToolContractError("result status must be completed, failed, or blocked")
    if result.status == "completed" and (result.error_code or result.error_message):
        raise RuntimeToolContractError("completed result must not contain error")
    if result.status != "completed" and not (result.error_code.strip() and result.error_message.strip()):
        raise RuntimeToolContractError("failed or blocked result requires error code and message")
    if _contains_forbidden_key(result.output):
        raise RuntimeToolContractError("runtime tool result must not contain routing fields")


def _parse_source(source: bytes | str | Path | ET.Element) -> ET.Element:
    try:
        if isinstance(source, ET.Element):
            return source
        if isinstance(source, Path) or (isinstance(source, str) and "<" not in source):
            return ET.parse(source).getroot()
        return ET.fromstring(source)
    except (OSError, ET.ParseError, TypeError) as exc:
        raise RuntimeToolContractError("invalid runtime tool XML") from exc


def _validate_root_attributes(root: ET.Element, required: tuple[str, ...]) -> None:
    if root.get("schemaVersion") != SCHEMA_VERSION:
        raise RuntimeToolContractError("unsupported runtime tool schema version")
    missing = [name for name in required if not root.get(name, "").strip()]
    if missing:
        raise RuntimeToolContractError("missing required attributes: " + ", ".join(missing))


def _append_value(parent: ET.Element, value: Any) -> None:
    node = ET.SubElement(parent, _tag("value"))
    if value is None:
        node.set("kind", "null")
    elif isinstance(value, bool):
        node.set("kind", "boolean")
        node.text = "true" if value else "false"
    elif isinstance(value, int):
        node.set("kind", "integer")
        node.text = str(value)
    elif isinstance(value, float):
        node.set("kind", "number")
        node.text = repr(value)
    elif isinstance(value, str):
        node.set("kind", "string")
        node.text = value
    elif isinstance(value, Mapping):
        node.set("kind", "map")
        for key, child in sorted(value.items(), key=lambda item: str(item[0])):
            entry = ET.SubElement(node, _tag("entry"), {"key": str(key)})
            _append_value(entry, child)
    elif isinstance(value, (list, tuple)):
        node.set("kind", "list")
        for child in value:
            _append_value(node, child)
    else:
        raise RuntimeToolContractError(f"unsupported runtime tool value: {type(value).__name__}")


def _read_single_value(parent: ET.Element) -> Any:
    children = list(parent)
    if len(children) != 1 or _local(children[0]) != "value":
        raise RuntimeToolContractError("container requires exactly one value")
    return _read_value(children[0])


def _read_value(node: ET.Element) -> Any:
    kind = node.get("kind")
    if kind == "null":
        return None
    if kind == "string":
        return node.text or ""
    if kind == "boolean":
        if node.text not in {"true", "false"}:
            raise RuntimeToolContractError("boolean must be true or false")
        return node.text == "true"
    if kind == "integer":
        try:
            return int(node.text or "")
        except ValueError as exc:
            raise RuntimeToolContractError("invalid integer") from exc
    if kind == "number":
        try:
            return float(node.text or "")
        except ValueError as exc:
            raise RuntimeToolContractError("invalid number") from exc
    if kind == "list":
        return [_read_value(child) for child in node if _local(child) == "value"]
    if kind == "map":
        result: dict[str, Any] = {}
        for entry in node:
            if _local(entry) != "entry" or not entry.get("key"):
                raise RuntimeToolContractError("map entries require key")
            key = entry.get("key", "")
            if key in result:
                raise RuntimeToolContractError(f"duplicate map key: {key}")
            result[key] = _read_single_value(entry)
        return result
    raise RuntimeToolContractError(f"unsupported runtime tool value kind: {kind}")


def _contains_forbidden_key(value: Any) -> bool:
    if isinstance(value, Mapping):
        return any(
            str(key) in _FORBIDDEN_RESULT_KEYS or _contains_forbidden_key(child)
            for key, child in value.items()
        )
    if isinstance(value, (list, tuple)):
        return any(_contains_forbidden_key(child) for child in value)
    return False


def _tag(name: str) -> str:
    return f"{{{NAMESPACE}}}{name}"


def _local(element: ET.Element) -> str:
    return element.tag.rsplit("}", 1)[-1]


def _serialize(root: ET.Element) -> bytes:
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


__all__ = [
    "NAMESPACE",
    "RuntimeToolContractError",
    "RuntimeToolRequest",
    "RuntimeToolResult",
    "request_from_xml",
    "request_to_xml",
    "result_from_xml",
    "result_to_xml",
    "write_xml",
]
