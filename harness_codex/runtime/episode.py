"""Run Episode 저장과 조회 유틸리티."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable, Mapping

from harness_codex.runtime.state import RunStateStore, file_checksum
from harness_codex.runtime.xml_state import find_run_state_path
from xml.etree import ElementTree as ET

EPISODE_SCHEMA_VERSION = 1
EPISODE_FILE_NAME = "episode.json"


def write_run_episode(repo_root: Path | str, run_id: str) -> Path:
    """한 run의 관측 artifact를 안전한 요약 episode로 고정한다."""

    root = Path(repo_root)
    run_dir = root / ".harness" / "runs" / run_id
    state = _load_state(root, run_id)
    report = _read_json(run_dir / "report.json")
    events = _read_run_events(root, run_id)
    metrics = _read_json(run_dir / "metrics.json")
    finalization = _finalization_summary(root, run_dir)
    materialized = _materialized_workflows(root, run_dir)
    verification = _verification_summary(root, run_dir)
    payload = {
        "schema_version": EPISODE_SCHEMA_VERSION,
        "run_id": run_id,
        "changeset_id": _value(state, "change_set_id") or report.get("change_set_id"),
        "work_item_ids": _work_item_ids(state, report, verification),
        "workflow_version": _value(state, "workflow_name") or report.get("workflow_name"),
        "agent_versions": _agent_versions(materialized),
        "stages": _stages(events),
        "verification": verification,
        "finalization": finalization,
        "artifacts": _artifact_summary(root, run_dir, materialized),
        "metrics": _safe_metrics(metrics),
        "final_status": _value(state, "status") or report.get("status"),
        "failure_class": _episode_failure_class(state, verification, finalization),
        "failure_fingerprint": _episode_failure_fingerprint(state, verification, finalization),
    }
    path = run_dir / EPISODE_FILE_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def read_run_episode(repo_root: Path | str, run_id: str) -> dict[str, Any]:
    path = Path(repo_root) / ".harness" / "runs" / run_id / EPISODE_FILE_NAME
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"episode must be a JSON object: {path}")
    return data


def read_run_episodes(repo_root: Path | str) -> tuple[dict[str, Any], ...]:
    root = Path(repo_root)
    episodes = []
    for path in sorted((root / ".harness" / "runs").glob(f"*/{EPISODE_FILE_NAME}")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(payload, dict):
            episodes.append(payload)
    seen = {str(item.get("run_id") or "") for item in episodes}
    for path in sorted((root / ".harness" / "runs").glob("*/procedure-run.json")):
        payload = _procedure_run_episode(root, path)
        if not payload:
            continue
        run_id = str(payload.get("run_id") or "")
        if run_id and run_id not in seen:
            episodes.append(payload)
            seen.add(run_id)
    for path in sorted((root / ".harness" / "runs").glob("*/grill-me-session.json")):
        payload = _interactive_run_episode(root, path)
        if not payload:
            continue
        run_id = str(payload.get("run_id") or "")
        if run_id and run_id not in seen:
            episodes.append(payload)
            seen.add(run_id)
    return tuple(episodes)


def _procedure_run_episode(root: Path, path: Path) -> dict[str, Any] | None:
    payload = _read_json(path)
    if not payload:
        return None
    run_id = str(payload.get("run_id") or path.parent.name)
    stage_id = str(payload.get("stage_id") or "")
    change_set_id = str(payload.get("change_set_id") or "")
    uc_id = str(payload.get("uc_id") or "")
    status = str(payload.get("status") or "")
    response = _procedure_run_response(path.parent, stage_id)
    error = _utf8_safe_text(response.get("error") or "")
    failure_class = _procedure_run_failure_class(status, error)
    return {
        "schema_version": EPISODE_SCHEMA_VERSION,
        "run_id": run_id,
        "changeset_id": change_set_id,
        "work_item_ids": [uc_id] if uc_id else [],
        "workflow_version": "procedure-stage",
        "agent_versions": {},
        "stages": [
            {
                "stage_id": stage_id,
                "status": status,
                "agent_status": payload.get("agent_status"),
            }
        ],
        "verification": {
            "failure_class": failure_class,
            "failure_fingerprint": _procedure_run_fingerprint(
                failure_class,
                stage_id,
                uc_id,
                error,
            ),
            "reports": [],
            "result": status,
        },
        "artifacts": {},
        "metrics": _safe_metrics({}),
        "final_status": "succeeded" if status == "verified" else status or None,
        "failure_class": failure_class,
        "failure_fingerprint": _procedure_run_fingerprint(
            failure_class,
            stage_id,
            uc_id,
            error,
        ),
    }


def _procedure_run_response(run_dir: Path, stage_id: str) -> dict[str, Any]:
    candidates = (
        run_dir / f"response-{stage_id}.json",
        run_dir / "steps" / stage_id / "result.json",
    )
    for candidate in candidates:
        payload = _read_json(candidate)
        if payload:
            return payload
    return {}


def _procedure_run_failure_class(status: str, error: str) -> str | None:
    if status != "blocked":
        return None
    if _text_is_environment_blocker(error):
        return "environment_blocker"
    return "procedure_stage_blocked"


def _procedure_run_fingerprint(
    failure_class: str | None,
    stage_id: str,
    uc_id: str,
    error: str,
) -> str | None:
    if not failure_class:
        return None
    return _fingerprint(failure_class, stage_id, uc_id, _error_fingerprint_token(error))


def _interactive_run_episode(root: Path, path: Path) -> dict[str, Any] | None:
    payload = _read_json(path)
    if not payload:
        return None
    run_id = str(payload.get("run_id") or path.parent.name)
    stage_id = str(payload.get("stage") or "")
    change_set_id = str(payload.get("change_set_id") or "")
    uc_id = str(payload.get("uc_id") or "")
    status = str(payload.get("status") or "")
    error = _interactive_run_error(path.parent)
    failure_class = _interactive_run_failure_class(status, error)
    final_status = "succeeded" if status == "complete" else status or None
    if status == "running" and failure_class:
        final_status = "blocked"
    return {
        "schema_version": EPISODE_SCHEMA_VERSION,
        "run_id": run_id,
        "changeset_id": change_set_id,
        "work_item_ids": [uc_id] if uc_id else [],
        "workflow_version": "interactive-procedure-stage",
        "agent_versions": {},
        "stages": [
            {
                "stage_id": stage_id,
                "status": status,
                "agent_status": status,
            }
        ],
        "verification": {
            "failure_class": failure_class,
            "failure_fingerprint": _procedure_run_fingerprint(
                failure_class,
                stage_id,
                uc_id,
                error,
            ),
            "reports": [],
            "result": final_status,
        },
        "artifacts": {},
        "metrics": _safe_metrics({}),
        "final_status": final_status,
        "failure_class": failure_class,
        "failure_fingerprint": _procedure_run_fingerprint(
            failure_class,
            stage_id,
            uc_id,
            error,
        ),
    }


def _interactive_run_error(run_dir: Path) -> str:
    parts: list[str] = []
    for path in sorted(run_dir.glob("turn-*/stderr.txt")):
        try:
            parts.append(path.read_text(encoding="utf-8", errors="replace")[-4000:])
        except OSError:
            continue
    return "\n".join(parts)


def _interactive_run_failure_class(status: str, error: str) -> str | None:
    if _text_is_environment_blocker(error):
        return "environment_blocker"
    if status == "blocked":
        return "procedure_stage_blocked"
    return None


def _utf8_safe_text(value: object) -> str:
    return str(value).encode("utf-8", errors="replace").decode("utf-8")


def _text_is_environment_blocker(value: str) -> bool:
    normalized = value.lower()
    markers = (
        "model is at capacity",
        "model is not supported",
        "invalid_request_error",
        "usage limit",
        "rate limit",
        "try again",
        "quota",
        "capacity",
    )
    return any(marker in normalized for marker in markers)


def _error_fingerprint_token(value: str) -> str:
    text = value.strip()
    if not text:
        return ""
    if _text_is_environment_blocker(text):
        return "environment"
    return text[:500]


def _read_run_events(repo_root: Path | str, run_id: str) -> tuple[dict[str, Any], ...]:
    path = Path(repo_root) / ".harness" / "runs" / run_id / "events.ndjson"
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ()
    events = []
    for line in lines:
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(payload, dict):
            events.append(payload)
    return tuple(events)


def _load_state(root: Path, run_id: str) -> Mapping[str, Any]:
    try:
        state = RunStateStore(root).load(run_id)
    except (OSError, ValueError, TypeError, KeyError):
        return {}
    return _to_json(state)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _materialized_workflows(root: Path, run_dir: Path) -> tuple[dict[str, Any], ...]:
    workflows = []
    for path in sorted(run_dir.glob("materialized-workflow-*.json")):
        payload = _read_json(path)
        if payload:
            payload["_path"] = str(path.relative_to(root))
            payload["_checksum"] = file_checksum(path)
            workflows.append(payload)
    return tuple(workflows)


def _verification_summary(root: Path, run_dir: Path) -> dict[str, Any]:
    reports = []
    for path in sorted((run_dir / "work-items").glob("*/verification/subagent-result.xml")):
        try:
            xml = ET.parse(path).getroot()
            outcome = next(child for child in xml if child.tag.rsplit("}", 1)[-1] == "outcome")
            status = outcome.get("status")
        except (OSError, ET.ParseError, StopIteration):
            continue
        work_item_id = path.parts[-3]
        reports.append(
            {
                "work_item_id": work_item_id,
                "path": str(path.relative_to(root)),
                "checksum": file_checksum(path),
                "result": status,
                "failure_class": None,
                "failure_fingerprint": None,
                "evidence": [],
            }
        )
    failure_reports = [item for item in reports if item.get("result") != "succeeded"]
    return {
        "result": "failed" if failure_reports else ("passed" if reports else None),
        "failure_class": failure_reports[0].get("failure_class") if failure_reports else None,
        "failure_fingerprint": failure_reports[0].get("failure_fingerprint") if failure_reports else None,
        "reports": reports,
    }


def _finalization_summary(root: Path, run_dir: Path) -> dict[str, Any]:
    path = run_dir / "finalization" / "report.json"
    payload = _read_json(path)
    if not payload:
        return {}
    step_results = payload.get("step_results")
    failed_step_id = str(payload.get("failed_step_id") or "")
    blocker = str(payload.get("blocker") or "")
    failure_class = _finalization_failure_class(
        failed_step_id=failed_step_id,
        blocker=blocker,
        failure_kind=str(payload.get("failure_kind") or ""),
    )
    return {
        "path": str(path.relative_to(root)),
        "checksum": file_checksum(path),
        "status": payload.get("status"),
        "failed_step_id": failed_step_id or None,
        "failure_kind": payload.get("failure_kind"),
        "failure_class": failure_class,
        "failure_fingerprint": _fingerprint(
            failure_class,
            failed_step_id,
            _error_fingerprint_token(blocker),
        )
        if failure_class
        else None,
        "blocker": blocker,
        "step_results": step_results if isinstance(step_results, list) else [],
    }


def _finalization_failure_class(
    *,
    failed_step_id: str,
    blocker: str,
    failure_kind: str,
) -> str | None:
    if not failed_step_id and not blocker and not failure_kind:
        return None
    normalized = blocker.lower()
    if _text_is_environment_blocker(normalized):
        return "environment_blocker"
    if failed_step_id == "create-change-set-pr":
        if "범위 밖 변경" in blocker or "out-of-scope" in normalized:
            return "delivery_scope_conflict"
        if "필요한 검사가" in blocker or "gate" in normalized:
            return "delivery_gate_policy_conflict"
        return "delivery_pr_failure"
    if failed_step_id == "verify-all-work-items-completed":
        return "work_item_completion_conflict"
    return _failure_kind_to_class(failure_kind or failed_step_id)


def _command_summaries(values: object) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []
    summaries = []
    for item in values:
        if not isinstance(item, Mapping):
            continue
        summaries.append(
            {
                "name": item.get("name"),
                "command": item.get("command"),
                "source": item.get("source"),
                "exit_code": item.get("exit_code"),
                "stdout_path": item.get("stdout_path"),
                "stderr_path": item.get("stderr_path"),
            }
        )
    return summaries


def _stages(events: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    stages = []
    attempts: dict[str, int] = {}
    for event in events:
        if event.get("event_type") != "step.finished":
            continue
        name = str(event.get("step_id") or "unknown")
        attempts[name] = attempts.get(name, 0) + 1
        stages.append(
            {
                "name": name,
                "kind": event.get("step_kind"),
                "duration_ms": event.get("duration_ms", 0),
                "attempt": attempts[name],
                "result": event.get("status"),
                "agent_id": event.get("agent_id"),
                "failure_kind": event.get("failure_kind"),
            }
        )
    return stages


def _artifact_summary(
    root: Path,
    run_dir: Path,
    materialized: tuple[Mapping[str, Any], ...],
) -> dict[str, Any]:
    candidates = {
        "run_report": run_dir / "report.json",
        "run_report_markdown": run_dir / "report.md",
        "events": run_dir / "events.ndjson",
        "metrics": run_dir / "metrics.json",
    }
    summary: dict[str, Any] = {
        key: _artifact_ref(root, path) for key, path in candidates.items() if path.exists()
    }
    try:
        state_path = find_run_state_path(root, run_dir.name)
    except FileNotFoundError:
        state_path = None
    if state_path is not None:
        summary["state_xml"] = _artifact_ref(root, state_path)
    summary["materialized_workflows"] = [
        {"path": item.get("_path"), "checksum": item.get("_checksum")}
        for item in materialized
    ]
    return summary


def _artifact_ref(root: Path, path: Path) -> dict[str, str]:
    return {"path": str(path.relative_to(root)), "checksum": file_checksum(path)}


def _agent_versions(materialized: tuple[Mapping[str, Any], ...]) -> dict[str, str]:
    agents: dict[str, str] = {}
    for workflow in materialized:
        for step in workflow.get("steps", []):
            if not isinstance(step, Mapping):
                continue
            agent_id = step.get("agent_id")
            if isinstance(agent_id, str) and agent_id:
                agents.setdefault(agent_id, "unversioned")
    return dict(sorted(agents.items()))


def _safe_metrics(metrics: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "event_count": metrics.get("event_count"),
        "started_at": metrics.get("started_at"),
        "last_observed_at": metrics.get("last_observed_at"),
        "status_counts": metrics.get("status_counts", {}),
        "bottlenecks": metrics.get("bottlenecks", []),
    }


def _work_item_ids(
    state: Mapping[str, Any],
    report: Mapping[str, Any],
    verification: Mapping[str, Any],
) -> list[str]:
    values = state.get("affected_work_items") or report.get("affected_work_items") or []
    if isinstance(values, list) and values:
        return [str(item) for item in values]
    reports = verification.get("reports", [])
    if isinstance(reports, list):
        return [str(item.get("work_item_id")) for item in reports if isinstance(item, Mapping)]
    return []


def _episode_failure_class(
    state: Mapping[str, Any],
    verification: Mapping[str, Any],
    finalization: Mapping[str, Any] | None = None,
) -> str | None:
    failure_class = verification.get("failure_class")
    if isinstance(failure_class, str) and failure_class:
        return failure_class
    if finalization:
        failure_class = finalization.get("failure_class")
        if isinstance(failure_class, str) and failure_class:
            return failure_class
    failure_kind = state.get("failure_kind")
    if isinstance(failure_kind, str) and failure_kind:
        return _failure_kind_to_class(failure_kind)
    blocked_stage = _blocked_procedure_stage(state)
    if blocked_stage:
        if _blocked_procedure_stage_is_environment(state):
            return "environment_blocker"
        return "procedure_stage_blocked"
    return None


def _episode_failure_fingerprint(
    state: Mapping[str, Any],
    verification: Mapping[str, Any],
    finalization: Mapping[str, Any] | None = None,
) -> str | None:
    value = verification.get("failure_fingerprint")
    if isinstance(value, str) and value:
        return value
    if finalization:
        value = finalization.get("failure_fingerprint")
        if isinstance(value, str) and value:
            return value
    failure_class = _episode_failure_class(state, verification, finalization)
    if not failure_class:
        return None
    blocked_stage = _blocked_procedure_stage(state)
    return _fingerprint(
        failure_class,
        blocked_stage,
        state.get("failed_step_id"),
        state.get("affected_work_items"),
        state.get("workflow_name"),
    )


def _blocked_procedure_stage(state: Mapping[str, Any]) -> str | None:
    decision_results = state.get("decision_results")
    if not isinstance(decision_results, Mapping):
        return None
    stage_results = decision_results.get("procedure_stage_results")
    if not isinstance(stage_results, Mapping):
        return None
    for stage_id, record in stage_results.items():
        if isinstance(record, Mapping) and record.get("status") == "blocked":
            return str(stage_id)
    return None


def _blocked_procedure_stage_is_environment(state: Mapping[str, Any]) -> bool:
    decision_results = state.get("decision_results")
    if not isinstance(decision_results, Mapping):
        return False
    stage_results = decision_results.get("procedure_stage_results")
    if not isinstance(stage_results, Mapping):
        return False
    markers = (
        "model is at capacity",
        "model is not supported",
        "invalid_request_error",
        "usage limit",
        "rate limit",
        "try again",
        "quota",
        "capacity",
    )
    for record in stage_results.values():
        if not isinstance(record, Mapping) or record.get("status") != "blocked":
            continue
        notes = str(record.get("notes") or "").lower()
        if any(marker in notes for marker in markers):
            return True
    return False


def _failure_kind_to_class(value: str) -> str:
    normalized = value.lower()
    if normalized in {"implementation", "implementation_failure"}:
        return "implementation_failure"
    if normalized == "environment_blocker":
        return "environment_blocker"
    if normalized == "scope_conflict":
        return "scope_conflict"
    if normalized == "verification_goal_unclear":
        return "verification_goal_unclear"
    return normalized


def _fingerprint(*parts: object) -> str:
    text = json.dumps(parts, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _value(mapping: Mapping[str, Any], key: str) -> Any:
    value = mapping.get(key)
    if isinstance(value, Mapping) and "value" in value:
        return value["value"]
    return value


def _to_json(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if hasattr(value, "value") and isinstance(value.value, str):
        return value.value
    if isinstance(value, tuple):
        return [_to_json(item) for item in value]
    if isinstance(value, list):
        return [_to_json(item) for item in value]
    if isinstance(value, dict):
        return {key: _to_json(item) for key, item in value.items()}
    if hasattr(value, "__dataclass_fields__"):
        return {key: _to_json(getattr(value, key)) for key in value.__dataclass_fields__}
    return value
