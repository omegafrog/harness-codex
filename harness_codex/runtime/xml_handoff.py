"""Fixed XML envelopes for workflow handoff contracts."""

from __future__ import annotations

import os
import tempfile
from enum import Enum
from pathlib import Path
from typing import Any, Mapping
from xml.etree import ElementTree as ET

NAMESPACE = "urn:harness:handoff:v1"
SCHEMA_VERSION = "1"

ET.register_namespace("", NAMESPACE)

_REQUIRED: dict[str, frozenset[str]] = {
    "execution-scope": frozenset(
        {
            "schema_version",
            "change_set_id",
            "work_item_id",
            "active_plan_path",
            "plan_sha256",
            "plan_fingerprint",
            "execution_report_path",
        }
    ),
    "execution-report": frozenset({"schema_version", "plan_fingerprint"}),
    "verification-report": frozenset(
        {
            "schema_version",
            "change_set_id",
            "work_item_id",
            "run_id",
            "status",
            "plan_path",
            "plan_sha256",
            "verification_goal_path",
            "evidence_items",
            "failure_class",
            "owner_stage",
            "recommended_resume_target",
            "repair",
        }
    ),
    "repair-brief": frozenset(
        {"schema_version", "change_set_id", "work_item_id", "run_id", "resume_target"}
    ),
    "security-profile": frozenset({"schema_version", "source_plan", "review_required"}),
    "security-controls": frozenset({"schema_version", "source", "selected_controls"}),
    "security-bundle-manifest": frozenset({"schema_version", "run_id", "work_item_id", "files"}),
    "token-metrics": frozenset({"schema_version", "run_id"}),
    "finalization-report": frozenset({"schema_version", "workflow", "status"}),
    "gate-verdict": frozenset({"schema_version", "gate_id", "status", "source_path"}),
}


class XmlHandoffValidationError(ValueError):
    """Raised when a fixed workflow handoff contract is malformed."""


def write_handoff(path: Path | str, handoff_type: str, payload: Mapping[str, Any]) -> Path:
    """Write one validated XML handoff atomically."""

    normalized = dict(payload)
    _validate_payload(handoff_type, normalized)
    root = ET.Element(
        _tag("harness-handoff"),
        {"schemaVersion": SCHEMA_VERSION, "type": handoff_type},
    )
    data = ET.SubElement(root, _tag("data"))
    _append_value(data, normalized)
    _atomic_write(Path(path), _serialize(root))
    return Path(path)


def read_handoff(path: Path | str, *, expected_type: str | None = None) -> dict[str, Any]:
    """Read a validated XML handoff and return its structured payload."""

    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError) as exc:
        raise XmlHandoffValidationError(f"invalid XML handoff: {path}") from exc
    if root.tag != _tag("harness-handoff"):
        raise XmlHandoffValidationError("handoff root must be harness-handoff")
    if root.get("schemaVersion") != SCHEMA_VERSION:
        raise XmlHandoffValidationError("unsupported handoff schema version")
    handoff_type = root.get("type")
    if handoff_type not in _REQUIRED:
        raise XmlHandoffValidationError(f"unsupported handoff type: {handoff_type}")
    if expected_type and handoff_type != expected_type:
        raise XmlHandoffValidationError(
            f"expected handoff type {expected_type}, got {handoff_type}"
        )
    children = list(root)
    if len(children) != 1 or _local(children[0]) != "data":
        raise XmlHandoffValidationError("handoff requires exactly one data element")
    payload = _read_container(children[0])
    _validate_payload(handoff_type, payload)
    return payload


def _validate_payload(handoff_type: str, payload: Mapping[str, Any]) -> None:
    if handoff_type not in _REQUIRED:
        raise XmlHandoffValidationError(f"unsupported handoff type: {handoff_type}")
    missing = [key for key in _REQUIRED[handoff_type] if key not in payload]
    if missing:
        raise XmlHandoffValidationError(
            f"{handoff_type} handoff is missing required fields: {', '.join(sorted(missing))}"
        )
    if handoff_type == "verification-report" and str(payload.get("status")) not in {"PASS", "FAIL"}:
        raise XmlHandoffValidationError("verification-report status must be PASS or FAIL")
    if handoff_type == "verification-report":
        if not isinstance(payload.get("evidence_items"), list):
            raise XmlHandoffValidationError("verification-report evidence_items must be a list")
        if str(payload.get("status")) == "FAIL":
            for key in ("failure_class", "owner_stage", "recommended_resume_target"):
                if not isinstance(payload.get(key), str) or not str(payload.get(key)).strip():
                    raise XmlHandoffValidationError(f"verification-report {key} is required on FAIL")
            if not isinstance(payload.get("repair"), Mapping) or not payload.get("repair"):
                raise XmlHandoffValidationError("verification-report repair is required on FAIL")
    if handoff_type == "gate-verdict" and str(payload.get("status")) not in {"approved", "rejected"}:
        raise XmlHandoffValidationError("gate-verdict status must be approved or rejected")
    if handoff_type == "security-profile" and not isinstance(payload.get("review_required"), bool):
        raise XmlHandoffValidationError("security-profile review_required must be boolean")


def _tag(name: str) -> str:
    return f"{{{NAMESPACE}}}{name}"


def _local(element: ET.Element) -> str:
    return element.tag.split("}", 1)[-1]


def _append_value(parent: ET.Element, value: Any) -> None:
    element = ET.SubElement(parent, _tag("value"))
    if value is None:
        element.set("kind", "null")
        return
    if isinstance(value, Enum):
        value = value.value
    if isinstance(value, Path):
        value = str(value)
    if isinstance(value, bool):
        element.set("kind", "boolean")
        element.text = "true" if value else "false"
        return
    if isinstance(value, int) and not isinstance(value, bool):
        element.set("kind", "integer")
        element.text = str(value)
        return
    if isinstance(value, float):
        element.set("kind", "number")
        element.text = repr(value)
        return
    if isinstance(value, str):
        element.set("kind", "string")
        element.text = value
        return
    if isinstance(value, Mapping):
        element.set("kind", "map")
        for key, child_value in sorted(value.items(), key=lambda item: str(item[0])):
            entry = ET.SubElement(element, _tag("entry"), {"key": str(key)})
            _append_value(entry, child_value)
        return
    if isinstance(value, (list, tuple)):
        element.set("kind", "list")
        for child_value in value:
            _append_value(element, child_value)
        return
    raise XmlHandoffValidationError(f"unsupported handoff value: {type(value).__name__}")


def _read_container(container: ET.Element) -> dict[str, Any]:
    values = list(container)
    if len(values) != 1 or _local(values[0]) != "value":
        raise XmlHandoffValidationError("handoff data must contain exactly one value")
    result = _read_value(values[0])
    if not isinstance(result, dict):
        raise XmlHandoffValidationError("handoff payload must be a map")
    return result


def _read_value(element: ET.Element) -> Any:
    kind = element.get("kind")
    if kind == "null":
        return None
    if kind == "boolean":
        if element.text == "true":
            return True
        if element.text == "false":
            return False
        raise XmlHandoffValidationError("boolean must be true or false")
    if kind == "integer":
        try:
            return int(element.text or "")
        except ValueError as exc:
            raise XmlHandoffValidationError("invalid integer") from exc
    if kind == "number":
        try:
            return float(element.text or "")
        except ValueError as exc:
            raise XmlHandoffValidationError("invalid number") from exc
    if kind == "string":
        return element.text or ""
    if kind == "list":
        return [_read_value(child) for child in element if _local(child) == "value"]
    if kind == "map":
        result: dict[str, Any] = {}
        for entry in element:
            if _local(entry) != "entry" or not entry.get("key"):
                raise XmlHandoffValidationError("map must contain keyed entries")
            children = list(entry)
            if len(children) != 1 or _local(children[0]) != "value":
                raise XmlHandoffValidationError("map entry must contain one value")
            key = str(entry.get("key"))
            if key in result:
                raise XmlHandoffValidationError(f"duplicate handoff key: {key}")
            result[key] = _read_value(children[0])
        return result
    raise XmlHandoffValidationError(f"unsupported handoff value kind: {kind}")


def _serialize(root: ET.Element) -> bytes:
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=".handoff-", suffix=".xml", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
