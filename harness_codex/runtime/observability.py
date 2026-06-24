"""Local-first runtime observability for harness workflow executions."""

from __future__ import annotations

import json
import math
import time
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable, Mapping

from harness_codex.runtime.models import RunContext, Step, StepResult
from harness_codex.runtime.runner import StepRunner

OBSERVABILITY_SCHEMA_VERSION = 1
_EVENT_FILE_NAME = "events.ndjson"
_METRICS_FILE_NAME = "metrics.json"
_SAFE_METADATA_KEYS = frozenset(
    {
        "execution_boundary",
        "active_work_item_type",
        "execution_mode",
        "attempt",
        "provider",
        "termination_reason",
        "review_cache_hit",
        "scope_diff_status",
        "review_gate_status",
        "rollback_mode",
    }
)


class RunEventWriter:
    """Best-effort append-only writer for one run's observable events."""

    def __init__(self, repo_root: Path | str, run_id: str) -> None:
        self._repo_root = Path(repo_root)
        self._run_id = run_id

    @property
    def path(self) -> Path:
        return self._repo_root / ".harness" / "runs" / self._run_id / _EVENT_FILE_NAME

    def start_run_if_absent(self, context: RunContext) -> bool:
        if self.path.exists() and self.path.stat().st_size > 0:
            return True
        return self.emit("run.started", context)

    def emit(
        self,
        event_type: str,
        context: RunContext,
        *,
        step: Step | None = None,
        result: StepResult | None = None,
        duration_ms: float | None = None,
        attributes: Mapping[str, Any] | None = None,
    ) -> bool:
        payload: dict[str, Any] = {
            "schema_version": OBSERVABILITY_SCHEMA_VERSION,
            "event_type": event_type,
            "occurred_at": _utc_now(),
            "run_id": context.run_id,
            "change_set_id": _context_string(context, "change_set_id"),
            "work_item_id": _context_string(context, "active_work_item_id"),
            "workflow_name": context.workflow_name,
        }
        if step is not None:
            payload["step_id"] = step.id
            payload["step_kind"] = step.kind.value
            if step.agent_id:
                payload["agent_id"] = step.agent_id
        if result is not None:
            payload["status"] = result.status.value
            payload["failure_kind"] = result.failure_kind.value if result.failure_kind else None
            payload["exit_code"] = result.exit_code
        if duration_ms is not None:
            payload["duration_ms"] = round(max(duration_ms, 0.0), 3)
        safe_attributes = _safe_attributes(attributes)
        if result is not None:
            safe_attributes.update(_safe_attributes(result.metadata))
        if safe_attributes:
            payload["attributes"] = safe_attributes
        return self._append(payload)

    def _append(self, payload: Mapping[str, Any]) -> bool:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
                stream.flush()
        except (OSError, TypeError, ValueError):
            return False
        return True


class ObservedStepRunner:
    """Decorate a step runner with durable, non-invasive timing events."""

    def __init__(
        self,
        delegate: StepRunner,
        writer_factory: Callable[[Path | str, str], RunEventWriter] = RunEventWriter,
    ) -> None:
        self._delegate = delegate
        self._writer_factory = writer_factory

    def run(self, step: Step, context: RunContext) -> StepResult:
        writer = self._writer_factory(context.repo_root, context.run_id)
        writer.start_run_if_absent(context)
        writer.emit("step.started", context, step=step)
        started_ns = time.perf_counter_ns()
        try:
            result = self._delegate.run(step, context)
        except BaseException as exc:
            duration_ms = _duration_ms(started_ns)
            writer.emit(
                "step.raised",
                context,
                step=step,
                duration_ms=duration_ms,
                attributes={"exception_type": type(exc).__name__},
            )
            _write_metrics_safely(context.repo_root, context.run_id)
            raise

        duration_ms = _duration_ms(started_ns)
        result = _with_total_duration(result, duration_ms)
        writer.emit("step.finished", context, step=step, result=result, duration_ms=duration_ms)
        _write_metrics_safely(context.repo_root, context.run_id)
        return result


def write_run_metrics(repo_root: Path | str, run_id: str) -> Path:
    """Build a deterministic metrics projection from the append-only event ledger."""

    root = Path(repo_root)
    run_dir = root / ".harness" / "runs" / run_id
    events = read_run_events(root, run_id)
    metrics = summarize_run_events(events, run_id=run_id)
    path = run_dir / _METRICS_FILE_NAME
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(metrics, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return path


def read_run_events(repo_root: Path | str, run_id: str) -> tuple[dict[str, Any], ...]:
    """Read only valid JSON object lines from a run event ledger."""

    path = Path(repo_root) / ".harness" / "runs" / run_id / _EVENT_FILE_NAME
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ()
    events: list[dict[str, Any]] = []
    for line in lines:
        try:
            candidate = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            events.append(candidate)
    return tuple(events)


def summarize_run_events(
    events: tuple[Mapping[str, Any], ...] | list[Mapping[str, Any]],
    *,
    run_id: str = "",
) -> dict[str, Any]:
    """Aggregate step timings and status distribution without retaining raw content."""

    step_durations: dict[tuple[str, str], list[float]] = {}
    step_statuses: dict[tuple[str, str], dict[str, int]] = {}
    status_counts: dict[str, int] = {}
    timestamps = [
        str(event["occurred_at"])
        for event in events
        if isinstance(event.get("occurred_at"), str) and event.get("occurred_at")
    ]

    for event in events:
        if event.get("event_type") != "step.finished":
            continue
        step_id = str(event.get("step_id") or "unknown")
        step_kind = str(event.get("step_kind") or "unknown")
        key = (step_id, step_kind)
        duration = event.get("duration_ms")
        if isinstance(duration, (int, float)) and not isinstance(duration, bool):
            step_durations.setdefault(key, []).append(float(duration))
        status = str(event.get("status") or "unknown")
        status_counts[status] = status_counts.get(status, 0) + 1
        per_step = step_statuses.setdefault(key, {})
        per_step[status] = per_step.get(status, 0) + 1

    step_metrics = [
        _step_metric(step_id, step_kind, values, step_statuses.get((step_id, step_kind), {}))
        for (step_id, step_kind), values in step_durations.items()
    ]
    step_metrics.sort(key=lambda item: (-item["total_ms"], item["step_id"], item["step_kind"]))
    started_at = min(timestamps) if timestamps else None
    last_observed_at = max(timestamps) if timestamps else None
    return {
        "schema_version": OBSERVABILITY_SCHEMA_VERSION,
        "run_id": run_id or _event_run_id(events),
        "event_count": len(events),
        "started_at": started_at,
        "last_observed_at": last_observed_at,
        "status_counts": dict(sorted(status_counts.items())),
        "step_metrics": step_metrics,
        "bottlenecks": step_metrics[:5],
    }


def render_run_metrics(metrics: Mapping[str, Any]) -> str:
    """Render a concise human-readable local observability summary."""

    lines = [
        f"Run: {metrics.get('run_id') or '-'}",
        f"Events: {metrics.get('event_count', 0)}",
        f"Status counts: {json.dumps(metrics.get('status_counts', {}), ensure_ascii=False, sort_keys=True)}",
        "Bottlenecks:",
    ]
    bottlenecks = metrics.get("bottlenecks", [])
    if not isinstance(bottlenecks, list) or not bottlenecks:
        lines.append("- none")
        return "\n".join(lines)
    for item in bottlenecks:
        if not isinstance(item, Mapping):
            continue
        lines.append(
            "- {step_id} ({step_kind}): total={total_ms:.3f}ms p95={p95_ms:.3f}ms count={count}".format(
                step_id=item.get("step_id", "unknown"),
                step_kind=item.get("step_kind", "unknown"),
                total_ms=float(item.get("total_ms", 0.0)),
                p95_ms=float(item.get("p95_ms", 0.0)),
                count=int(item.get("count", 0)),
            )
        )
    return "\n".join(lines)


def _step_metric(
    step_id: str,
    step_kind: str,
    durations: list[float],
    statuses: Mapping[str, int],
) -> dict[str, Any]:
    ordered = sorted(durations)
    total = sum(ordered)
    return {
        "step_id": step_id,
        "step_kind": step_kind,
        "count": len(ordered),
        "total_ms": round(total, 3),
        "average_ms": round(total / len(ordered), 3),
        "p50_ms": round(_percentile(ordered, 0.50), 3),
        "p95_ms": round(_percentile(ordered, 0.95), 3),
        "max_ms": round(ordered[-1], 3),
        "status_counts": dict(sorted(statuses.items())),
    }


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    if len(values) == 1:
        return values[0]
    rank = (len(values) - 1) * percentile
    lower = math.floor(rank)
    upper = math.ceil(rank)
    if lower == upper:
        return values[lower]
    return values[lower] + (values[upper] - values[lower]) * (rank - lower)


def _with_total_duration(result: StepResult, duration_ms: float) -> StepResult:
    existing = result.metadata.get("phase_metrics")
    phase_metrics = dict(existing) if isinstance(existing, Mapping) else {}
    phase_metrics["total_ms"] = round(max(duration_ms, 0.0), 3)
    return replace(result, metadata={**dict(result.metadata), "phase_metrics": phase_metrics})


def _safe_attributes(values: Mapping[str, Any] | None) -> dict[str, Any]:
    if not isinstance(values, Mapping):
        return {}
    safe: dict[str, Any] = {}
    for key in _SAFE_METADATA_KEYS:
        value = values.get(key)
        if isinstance(value, (str, int, float, bool)) or value is None:
            if value is not None:
                safe[key] = value
    return safe


def _context_string(context: RunContext, key: str) -> str | None:
    value = context.metadata.get(key)
    return str(value) if value not in (None, "") else None


def _duration_ms(started_ns: int) -> float:
    return (time.perf_counter_ns() - started_ns) / 1_000_000


def _utc_now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _event_run_id(events: tuple[Mapping[str, Any], ...] | list[Mapping[str, Any]]) -> str:
    for event in events:
        run_id = event.get("run_id")
        if isinstance(run_id, str) and run_id:
            return run_id
    return ""


def _write_metrics_safely(repo_root: Path | str, run_id: str) -> None:
    try:
        write_run_metrics(repo_root, run_id)
    except (OSError, TypeError, ValueError):
        return
