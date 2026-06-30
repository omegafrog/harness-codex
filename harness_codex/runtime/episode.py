"""Run Episode 저장과 조회 유틸리티."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Iterable, Mapping

from harness_codex.runtime.state import RunStateStore, file_checksum

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
        "artifacts": _artifact_summary(root, run_dir, materialized),
        "metrics": _safe_metrics(metrics),
        "final_status": _value(state, "status") or report.get("status"),
        "failure_class": _episode_failure_class(state, verification),
        "failure_fingerprint": _episode_failure_fingerprint(state, verification),
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
    return tuple(episodes)


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
    except (OSError, ValueError, TypeError):
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
    for path in sorted((run_dir / "work-items").glob("*/verification/report.json")):
        payload = _read_json(path)
        work_item_id = path.parts[-3]
        reports.append(
            {
                "work_item_id": work_item_id,
                "path": str(path.relative_to(root)),
                "checksum": file_checksum(path),
                "result": payload.get("status") or payload.get("result"),
                "failure_class": payload.get("failure_class"),
                "owner_stage": payload.get("owner_stage"),
                "recommended_resume_target": payload.get("recommended_resume_target"),
                "failure_fingerprint": payload.get("failure_fingerprint")
                or _fingerprint(
                    payload.get("failure_class"),
                    payload.get("failed_gates"),
                    payload.get("failed_commands"),
                    payload.get("unmet_obligations"),
                ),
                "failed_tests": payload.get("failed_tests", []),
                "failed_gates": payload.get("failed_gates", []),
                "failed_commands": _command_summaries(payload.get("failed_commands", [])),
                "unmet_obligations": payload.get("unmet_obligations", []),
                "evidence": payload.get("evidence", []),
            }
        )
    failure_reports = [item for item in reports if item.get("failure_class")]
    return {
        "result": "failed" if failure_reports else ("passed" if reports else None),
        "failure_class": failure_reports[0].get("failure_class") if failure_reports else None,
        "failure_fingerprint": failure_reports[0].get("failure_fingerprint") if failure_reports else None,
        "reports": reports,
    }


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
        "state": run_dir / "state.json",
        "run_report": run_dir / "report.json",
        "run_report_markdown": run_dir / "report.md",
        "events": run_dir / "events.ndjson",
        "metrics": run_dir / "metrics.json",
    }
    summary: dict[str, Any] = {
        key: _artifact_ref(root, path) for key, path in candidates.items() if path.exists()
    }
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
) -> str | None:
    failure_class = verification.get("failure_class")
    if isinstance(failure_class, str) and failure_class:
        return failure_class
    failure_kind = state.get("failure_kind")
    if isinstance(failure_kind, str) and failure_kind:
        return _failure_kind_to_class(failure_kind)
    return None


def _episode_failure_fingerprint(
    state: Mapping[str, Any],
    verification: Mapping[str, Any],
) -> str | None:
    value = verification.get("failure_fingerprint")
    if isinstance(value, str) and value:
        return value
    failure_class = _episode_failure_class(state, verification)
    if not failure_class:
        return None
    return _fingerprint(
        failure_class,
        state.get("failed_step_id"),
        state.get("affected_work_items"),
        state.get("workflow_name"),
    )


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
