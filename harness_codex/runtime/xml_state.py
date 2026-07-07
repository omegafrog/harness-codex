"""XML persistence for the canonical ChangeSet runtime state.

The runtime used to persist equivalent state in per-run JSON files, a SQLite
step ledger, scoped UI sessions, and a Markdown procedure table.  This module
provides the durable source document used by the runtime: one XML document per
ChangeSet at ``.harness/state/changesets/<CHG-ID>/state.xml``.

``RunState`` remains the in-process model so existing callers do not have to
know about XML.  A ChangeSet document can contain more than one run because a
ChangeSet may be resumed or re-run; all of those run records still live in one
canonical file.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import asdict
from enum import Enum
from pathlib import Path
from typing import Any, Iterable, Mapping
from xml.etree import ElementTree as ET

from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.models import RunMode, RunStatus

STATE_NAMESPACE = "urn:harness:state:v1"
SCHEMA_VERSION = "1"
_STATE_DIR = Path(".harness/state/changesets")

ET.register_namespace("", STATE_NAMESPACE)


class XmlStateValidationError(ValueError):
    """Raised when a state document violates the fixed XML contract."""


def _tag(name: str) -> str:
    return f"{{{STATE_NAMESPACE}}}{name}"


def _local(element: ET.Element) -> str:
    if not element.tag.startswith("{"):
        return element.tag
    return element.tag.split("}", 1)[1]


def change_set_state_path(repo_root: Path | str, change_set_id: str) -> Path:
    """Return the one canonical XML document path for a ChangeSet."""

    return Path(repo_root) / _STATE_DIR / change_set_id / "state.xml"


def save_run_state(repo_root: Path | str, state: Any) -> Path:
    """Upsert one RunState record into its ChangeSet XML document atomically."""

    path = change_set_state_path(repo_root, state.change_set_id)
    root = _load_document_or_new(path, state.change_set_id)
    runs = _single_child(root, "runs", required=True)
    replacement = run_state_to_element(state)
    for existing in list(runs):
        if existing.get("runId") == state.run_id:
            runs.remove(existing)
            break
    runs.append(replacement)
    _sort_runs(runs)
    _validate_document(root)
    _atomic_write(path, _serialize(root))
    return path


def load_run_state(repo_root: Path | str, run_id: str) -> Any:
    """Load a run by id, scanning canonical ChangeSet state documents only."""

    root_path = Path(repo_root) / _STATE_DIR
    if not root_path.exists():
        raise FileNotFoundError(f"No canonical XML state exists for run: {run_id}")
    for path in sorted(root_path.glob("*/state.xml")):
        root = _parse_document(path)
        runs = _single_child(root, "runs", required=True)
        for element in runs:
            if _local(element) == "run-state" and element.get("runId") == run_id:
                return run_state_from_element(element)
    raise FileNotFoundError(f"No canonical XML state exists for run: {run_id}")


def list_run_states(repo_root: Path | str) -> tuple[Any, ...]:
    """List every run stored in canonical ChangeSet XML documents."""

    root_path = Path(repo_root) / _STATE_DIR
    if not root_path.exists():
        return ()
    states: list[Any] = []
    for path in sorted(root_path.glob("*/state.xml")):
        root = _parse_document(path)
        runs = _single_child(root, "runs", required=True)
        states.extend(
            run_state_from_element(element)
            for element in runs
            if _local(element) == "run-state"
        )
    return tuple(states)


def find_run_state_path(repo_root: Path | str, run_id: str) -> Path:
    """Find the ChangeSet XML document containing ``run_id``."""

    root_path = Path(repo_root) / _STATE_DIR
    for path in sorted(root_path.glob("*/state.xml")):
        root = _parse_document(path)
        runs = _single_child(root, "runs", required=True)
        if any(
            _local(element) == "run-state" and element.get("runId") == run_id
            for element in runs
        ):
            return path
    raise FileNotFoundError(f"No canonical XML state exists for run: {run_id}")


def run_state_to_element(state: Any) -> ET.Element:
    """Serialize the fixed RunState model without embedding JSON in XML."""

    root = ET.Element(
        _tag("run-state"),
        {
            "runId": state.run_id,
            "changeSetId": state.change_set_id,
            "workflowName": state.workflow_name,
            "mode": _enum_value(state.mode),
            "status": _enum_value(state.status),
        },
    )
    _append_ids(root, "affected-use-cases", state.affected_use_cases)
    _append_ids(root, "affected-work-items", state.affected_work_items)
    _append_ids(root, "completed-use-cases", state.completed_use_cases)
    _append_ids(root, "completed-work-items", state.completed_work_items)
    _append_ids(root, "blocked-use-cases", state.blocked_use_cases)
    _append_ids(root, "blocked-work-items", state.blocked_work_items)

    current = ET.SubElement(root, _tag("current"))
    _set_optional(current, "useCaseId", state.current_use_case_id)
    _set_optional(current, "workItemId", state.current_work_item_id)
    _set_optional(current, "stepId", state.current_step_id)
    _set_optional(current, "failedStepId", state.failed_step_id)
    _set_optional(current, "failureKind", state.failure_kind)

    use_cases = ET.SubElement(root, _tag("use-case-states"))
    for item in state.use_case_states:
        element = ET.SubElement(
            use_cases,
            _tag("use-case"),
            {
                "id": item.uc_id,
                "activePlanPath": str(item.active_plan_path),
                "status": _enum_value(item.status),
                "currentStepId": _enum_value(item.current_step_id),
                "verificationStatus": item.verification_status,
                "retryCount": str(item.retry_count),
            },
        )
        _set_optional(element, "failureKind", item.failure_kind)
        _set_optional(element, "blocker", item.blocker)
        _append_mapping(element, "last-executor-result", item.last_executor_result)
        _append_mapping(element, "last-verifier-result", item.last_verifier_result)

    work_items = ET.SubElement(root, _tag("work-item-states"))
    for item in state.work_item_states:
        element = ET.SubElement(
            work_items,
            _tag("work-item"),
            {
                "id": item.work_item_id,
                "type": _enum_value(item.work_item_type),
                "activePlanPath": str(item.active_plan_path),
                "status": _enum_value(item.status),
                "currentStepId": item.current_step_id,
                "verificationStatus": item.verification_status,
                "retryCount": str(item.retry_count),
            },
        )
        _set_optional(element, "failureKind", item.failure_kind)
        _set_optional(element, "blocker", item.blocker)
        _append_mapping(element, "last-executor-result", item.last_executor_result)
        _append_mapping(element, "last-verifier-result", item.last_verifier_result)

    artifacts = ET.SubElement(root, _tag("artifact-states"))
    for item in state.artifact_states:
        ET.SubElement(
            artifacts,
            _tag("artifact"),
            {
                "stage": item.stage,
                "path": str(item.path),
                "checksum": item.checksum,
                "revision": str(item.revision),
                "generatedBy": item.generated_by,
                "accepted": _bool(item.accepted),
                "dirtyState": _enum_value(item.dirty_state),
                "downstreamStatus": _enum_value(item.downstream_status),
            },
        )

    _append_mapping(root, "decision-results", state.decision_results)
    return root


def run_state_from_element(element: ET.Element) -> Any:
    """Deserialize one ``run-state`` element into the runtime dataclasses."""

    from harness_codex.runtime.state import (
        ArtifactDirtyState,
        RunFailureKind,
        RunState,
        StageArtifactState,
        UseCaseLoopState,
        UseCaseStep,
        WorkItemLoopState,
    )

    _validate_run_state(element)
    current = _single_child(element, "current", required=True)
    use_cases = _single_child(element, "use-case-states", required=True)
    work_items = _single_child(element, "work-item-states", required=True)
    artifacts = _single_child(element, "artifact-states", required=True)

    def optional_failure(value: str | None) -> RunFailureKind | None:
        return RunFailureKind(value) if value else None

    return RunState(
        run_id=_required(element, "runId"),
        change_set_id=_required(element, "changeSetId"),
        workflow_name=_required(element, "workflowName"),
        mode=RunMode(_required(element, "mode")),
        affected_use_cases=_read_ids(element, "affected-use-cases"),
        affected_work_items=_read_ids(element, "affected-work-items"),
        current_use_case_id=current.get("useCaseId"),
        current_work_item_id=current.get("workItemId"),
        current_step_id=(UseCaseStep(current.get("stepId")) if current.get("stepId") else None),
        completed_use_cases=_read_ids(element, "completed-use-cases"),
        completed_work_items=_read_ids(element, "completed-work-items"),
        blocked_use_cases=_read_ids(element, "blocked-use-cases"),
        blocked_work_items=_read_ids(element, "blocked-work-items"),
        failed_step_id=current.get("failedStepId"),
        failure_kind=optional_failure(current.get("failureKind")),
        status=RunStatus(_required(element, "status")),
        decision_results=_read_mapping(element, "decision-results"),
        use_case_states=tuple(
            UseCaseLoopState(
                uc_id=_required(item, "id"),
                active_plan_path=Path(_required(item, "activePlanPath")),
                status=RunStatus(_required(item, "status")),
                current_step_id=UseCaseStep(_required(item, "currentStepId")),
                verification_status=item.get("verificationStatus", ""),
                retry_count=_integer(item, "retryCount"),
                last_executor_result=_read_mapping(item, "last-executor-result"),
                last_verifier_result=_read_mapping(item, "last-verifier-result"),
                failure_kind=optional_failure(item.get("failureKind")),
                blocker=item.get("blocker"),
            )
            for item in use_cases
            if _local(item) == "use-case"
        ),
        work_item_states=tuple(
            WorkItemLoopState(
                work_item_id=_required(item, "id"),
                work_item_type=WorkItemType(_required(item, "type")),
                active_plan_path=Path(_required(item, "activePlanPath")),
                status=RunStatus(_required(item, "status")),
                current_step_id=_required(item, "currentStepId"),
                verification_status=item.get("verificationStatus", ""),
                retry_count=_integer(item, "retryCount"),
                last_executor_result=_read_mapping(item, "last-executor-result"),
                last_verifier_result=_read_mapping(item, "last-verifier-result"),
                failure_kind=optional_failure(item.get("failureKind")),
                blocker=item.get("blocker"),
            )
            for item in work_items
            if _local(item) == "work-item"
        ),
        artifact_states=tuple(
            StageArtifactState(
                stage=_required(item, "stage"),
                path=Path(_required(item, "path")),
                checksum=item.get("checksum", ""),
                revision=_integer(item, "revision"),
                generated_by=item.get("generatedBy", "runtime"),
                accepted=_parse_bool(_required(item, "accepted")),
                dirty_state=ArtifactDirtyState(_required(item, "dirtyState")),
                downstream_status=ArtifactDirtyState(_required(item, "downstreamStatus")),
            )
            for item in artifacts
            if _local(item) == "artifact"
        ),
    )


def _load_document_or_new(path: Path, change_set_id: str) -> ET.Element:
    if path.exists():
        root = _parse_document(path)
        if root.get("changeSetId") != change_set_id:
            raise XmlStateValidationError("state document ChangeSet id does not match path")
        return root
    root = ET.Element(
        _tag("harness-state"),
        {"schemaVersion": SCHEMA_VERSION, "changeSetId": change_set_id},
    )
    ET.SubElement(root, _tag("runs"))
    return root


def _parse_document(path: Path) -> ET.Element:
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as exc:
        raise XmlStateValidationError(f"invalid XML state document: {path}") from exc
    _validate_document(root)
    return root


def _validate_document(root: ET.Element) -> None:
    if root.tag != _tag("harness-state"):
        raise XmlStateValidationError("state document root must be harness-state in the fixed namespace")
    _allow_attributes(root, {"schemaVersion", "changeSetId"})
    if root.get("schemaVersion") != SCHEMA_VERSION:
        raise XmlStateValidationError("unsupported state XML schemaVersion")
    if not root.get("changeSetId"):
        raise XmlStateValidationError("state document requires changeSetId")
    _allow_children(root, {"runs"})
    runs = _single_child(root, "runs", required=True)
    _allow_attributes(runs, set())
    _allow_children(runs, {"run-state"})
    seen: set[str] = set()
    for run in runs:
        _validate_run_state(run)
        if run.get("changeSetId") != root.get("changeSetId"):
            raise XmlStateValidationError("run ChangeSet id must match document ChangeSet id")
        run_id = _required(run, "runId")
        if run_id in seen:
            raise XmlStateValidationError(f"duplicate run id in ChangeSet XML: {run_id}")
        seen.add(run_id)


def _validate_run_state(element: ET.Element) -> None:
    if element.tag != _tag("run-state"):
        raise XmlStateValidationError("runs may contain only run-state elements")
    _allow_attributes(
        element,
        {"runId", "changeSetId", "workflowName", "mode", "status"},
    )
    for name in ("runId", "changeSetId", "workflowName", "mode", "status"):
        _required(element, name)
    _validate_enum(RunMode, element.get("mode"), "mode")
    _validate_enum(RunStatus, element.get("status"), "status")
    _allow_children(
        element,
        {
            "affected-use-cases",
            "affected-work-items",
            "completed-use-cases",
            "completed-work-items",
            "blocked-use-cases",
            "blocked-work-items",
            "current",
            "use-case-states",
            "work-item-states",
            "artifact-states",
            "decision-results",
        },
    )
    for name in (
        "affected-use-cases",
        "affected-work-items",
        "completed-use-cases",
        "completed-work-items",
        "blocked-use-cases",
        "blocked-work-items",
    ):
        _validate_ids(_single_child(element, name, required=True))
    current = _single_child(element, "current", required=True)
    _allow_attributes(current, {"useCaseId", "workItemId", "stepId", "failedStepId", "failureKind"})
    if current.get("failureKind"):
        _validate_run_failure(current.get("failureKind"))
    _validate_use_case_states(_single_child(element, "use-case-states", required=True))
    _validate_work_item_states(_single_child(element, "work-item-states", required=True))
    _validate_artifacts(_single_child(element, "artifact-states", required=True))
    _validate_mapping_container(_single_child(element, "decision-results", required=True))


def _validate_ids(element: ET.Element) -> None:
    _allow_attributes(element, set())
    _allow_children(element, {"id"})
    for item in element:
        _allow_attributes(item, set())
        if not (item.text or "").strip():
            raise XmlStateValidationError("id value must not be blank")


def _validate_use_case_states(element: ET.Element) -> None:
    from harness_codex.runtime.state import RunFailureKind, UseCaseStep

    _allow_attributes(element, set())
    _allow_children(element, {"use-case"})
    for item in element:
        _allow_attributes(
            item,
            {"id", "activePlanPath", "status", "currentStepId", "verificationStatus", "retryCount", "failureKind", "blocker"},
        )
        for name in ("id", "activePlanPath", "status", "currentStepId", "retryCount"):
            _required(item, name)
        _validate_enum(RunStatus, item.get("status"), "use-case status")
        _validate_enum(UseCaseStep, item.get("currentStepId"), "use-case currentStepId")
        if item.get("failureKind"):
            _validate_enum(RunFailureKind, item.get("failureKind"), "use-case failureKind")
        _integer(item, "retryCount")
        _allow_children(item, {"last-executor-result", "last-verifier-result"})
        _validate_mapping_container(_single_child(item, "last-executor-result", required=True))
        _validate_mapping_container(_single_child(item, "last-verifier-result", required=True))


def _validate_work_item_states(element: ET.Element) -> None:
    from harness_codex.runtime.state import RunFailureKind

    _allow_attributes(element, set())
    _allow_children(element, {"work-item"})
    for item in element:
        _allow_attributes(
            item,
            {"id", "type", "activePlanPath", "status", "currentStepId", "verificationStatus", "retryCount", "failureKind", "blocker"},
        )
        for name in ("id", "type", "activePlanPath", "status", "currentStepId", "retryCount"):
            _required(item, name)
        _validate_enum(WorkItemType, item.get("type"), "work-item type")
        _validate_enum(RunStatus, item.get("status"), "work-item status")
        if item.get("failureKind"):
            _validate_enum(RunFailureKind, item.get("failureKind"), "work-item failureKind")
        _integer(item, "retryCount")
        _allow_children(item, {"last-executor-result", "last-verifier-result"})
        _validate_mapping_container(_single_child(item, "last-executor-result", required=True))
        _validate_mapping_container(_single_child(item, "last-verifier-result", required=True))


def _validate_artifacts(element: ET.Element) -> None:
    from harness_codex.runtime.state import ArtifactDirtyState

    _allow_attributes(element, set())
    _allow_children(element, {"artifact"})
    seen: set[tuple[str, str]] = set()
    for item in element:
        _allow_attributes(
            item,
            {"stage", "path", "checksum", "revision", "generatedBy", "accepted", "dirtyState", "downstreamStatus"},
        )
        for name in ("stage", "path", "revision", "generatedBy", "accepted", "dirtyState", "downstreamStatus"):
            _required(item, name)
        key = (_required(item, "stage"), _required(item, "path"))
        if key in seen:
            raise XmlStateValidationError(f"duplicate artifact: {key[0]} {key[1]}")
        seen.add(key)
        _integer(item, "revision")
        _parse_bool(_required(item, "accepted"))
        _validate_enum(ArtifactDirtyState, item.get("dirtyState"), "artifact dirtyState")
        _validate_enum(ArtifactDirtyState, item.get("downstreamStatus"), "artifact downstreamStatus")


def _append_ids(parent: ET.Element, name: str, values: Iterable[str]) -> None:
    container = ET.SubElement(parent, _tag(name))
    for value in values:
        child = ET.SubElement(container, _tag("id"))
        child.text = str(value)


def _read_ids(parent: ET.Element, name: str) -> tuple[str, ...]:
    container = _single_child(parent, name, required=True)
    return tuple((item.text or "").strip() for item in container if _local(item) == "id")


def _append_mapping(parent: ET.Element, name: str, value: Mapping[str, Any]) -> None:
    container = ET.SubElement(parent, _tag(name))
    _append_value(container, value)


def _read_mapping(parent: ET.Element, name: str) -> Mapping[str, Any]:
    container = _single_child(parent, name, required=True)
    value = _single_child(container, "value", required=True)
    parsed = _read_value(value)
    if not isinstance(parsed, dict):
        raise XmlStateValidationError(f"{name} must contain an XML map")
    return parsed


def _append_value(parent: ET.Element, value: Any) -> None:
    element = ET.SubElement(parent, _tag("value"))
    if value is None:
        element.set("kind", "null")
        return
    if isinstance(value, Path):
        value = str(value)
    if isinstance(value, Enum):
        value = value.value
    if isinstance(value, bool):
        element.set("kind", "boolean")
        element.text = _bool(value)
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
        for key in sorted((str(key) for key in value), key=str):
            entry = ET.SubElement(element, _tag("entry"), {"key": key})
            _append_value(entry, value[key])
        return
    if isinstance(value, (tuple, list)):
        element.set("kind", "list")
        for item in value:
            _append_value(element, item)
        return
    if hasattr(value, "__dataclass_fields__"):
        _append_value(parent, asdict(value))
        parent.remove(element)
        return
    raise XmlStateValidationError(f"unsupported XML metadata value: {type(value).__name__}")


def _read_value(element: ET.Element) -> Any:
    kind = _required(element, "kind")
    if kind == "null":
        return None
    if kind == "boolean":
        return _parse_bool((element.text or "").strip())
    if kind == "integer":
        try:
            return int((element.text or "").strip())
        except ValueError as exc:
            raise XmlStateValidationError("invalid integer metadata value") from exc
    if kind == "number":
        try:
            return float((element.text or "").strip())
        except ValueError as exc:
            raise XmlStateValidationError("invalid numeric metadata value") from exc
    if kind == "string":
        return element.text or ""
    if kind == "list":
        return [_read_value(child) for child in element if _local(child) == "value"]
    if kind == "map":
        result: dict[str, Any] = {}
        for entry in element:
            if _local(entry) != "entry":
                raise XmlStateValidationError("map may contain only entry")
            key = _required(entry, "key")
            value = _single_child(entry, "value", required=True)
            result[key] = _read_value(value)
        return result
    raise XmlStateValidationError(f"unsupported XML metadata kind: {kind}")


def _validate_mapping_container(container: ET.Element) -> None:
    _allow_attributes(container, set())
    _allow_children(container, {"value"})
    value = _single_child(container, "value", required=True)
    _validate_value(value)
    if value.get("kind") != "map":
        raise XmlStateValidationError("metadata container must contain a map")


def _validate_value(element: ET.Element) -> None:
    _allow_attributes(element, {"kind"})
    kind = _required(element, "kind")
    allowed = {"null", "boolean", "integer", "number", "string", "list", "map"}
    if kind not in allowed:
        raise XmlStateValidationError(f"unsupported XML metadata kind: {kind}")
    if kind in {"null", "boolean", "integer", "number", "string"}:
        _allow_children(element, set())
        _read_value(element)
        return
    if kind == "list":
        _allow_children(element, {"value"})
        for child in element:
            _validate_value(child)
        return
    _allow_children(element, {"entry"})
    seen: set[str] = set()
    for entry in element:
        _allow_attributes(entry, {"key"})
        key = _required(entry, "key")
        if key in seen:
            raise XmlStateValidationError(f"duplicate metadata key: {key}")
        seen.add(key)
        _allow_children(entry, {"value"})
        _validate_value(_single_child(entry, "value", required=True))


def _single_child(parent: ET.Element, name: str, *, required: bool) -> ET.Element:
    matches = [child for child in parent if _local(child) == name]
    if len(matches) != 1:
        if required:
            raise XmlStateValidationError(f"{_local(parent)} requires exactly one {name} child")
        raise XmlStateValidationError(f"{_local(parent)} has an invalid {name} child count")
    return matches[0]


def _allow_children(parent: ET.Element, allowed: set[str]) -> None:
    invalid = [_local(child) for child in parent if _local(child) not in allowed]
    if invalid:
        raise XmlStateValidationError(
            f"{_local(parent)} has unsupported XML child: {', '.join(invalid)}"
        )


def _allow_attributes(element: ET.Element, allowed: set[str]) -> None:
    invalid = set(element.attrib) - allowed
    if invalid:
        raise XmlStateValidationError(
            f"{_local(element)} has unsupported XML attribute: {', '.join(sorted(invalid))}"
        )


def _required(element: ET.Element, name: str) -> str:
    value = element.get(name)
    if value in (None, ""):
        raise XmlStateValidationError(f"{_local(element)} requires {name}")
    return value


def _integer(element: ET.Element, name: str) -> int:
    try:
        return int(_required(element, name))
    except ValueError as exc:
        raise XmlStateValidationError(f"{_local(element)} {name} must be an integer") from exc


def _parse_bool(value: str) -> bool:
    if value == "true":
        return True
    if value == "false":
        return False
    raise XmlStateValidationError("boolean value must be true or false")


def _bool(value: bool) -> str:
    return "true" if value else "false"


def _enum_value(value: Any) -> str:
    return value.value if isinstance(value, Enum) else str(value)


def _set_optional(element: ET.Element, name: str, value: Any) -> None:
    if value not in (None, ""):
        element.set(name, _enum_value(value))


def _validate_enum(enum_type: type[Enum], value: str | None, name: str) -> None:
    try:
        enum_type(value)
    except (TypeError, ValueError) as exc:
        raise XmlStateValidationError(f"invalid {name}: {value}") from exc


def _validate_run_failure(value: str | None) -> None:
    from harness_codex.runtime.state import RunFailureKind

    _validate_enum(RunFailureKind, value, "failureKind")


def _sort_runs(runs: ET.Element) -> None:
    ordered = sorted(list(runs), key=lambda item: item.get("runId", ""))
    runs[:] = ordered


def _serialize(root: ET.Element) -> bytes:
    ET.indent(root, space="  ")
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=".state-", suffix=".xml", dir=path.parent)
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)
