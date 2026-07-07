"""Keep token metrics available after successful stdout retention is compacted."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping


def apply_token_observability_trace_retention_patch() -> None:
    """Use the compact usage persisted in result metadata when stdout is absent."""

    import harness_codex.runtime.token_observability as observability

    original_collect_step = observability._collect_step
    if getattr(original_collect_step, "_trace_retention_usage_fallback", False):
        return

    def collect_step(repo_root: Path, step_dir: Path) -> dict[str, Any] | None:
        record = original_collect_step(repo_root, step_dir)
        if record is None or record.get("usage_source") == "provider":
            return record

        usage = _compact_provider_usage(observability._read_json(step_dir / "result.json"))
        normalized = observability._normalize(usage)
        if not any(value is not None for value in normalized.values()):
            return record

        record.update(normalized)
        record["usage_source"] = "provider"
        observability._write_json(step_dir / "usage.json", record)
        return record

    collect_step._trace_retention_usage_fallback = True
    observability._collect_step = collect_step


def _compact_provider_usage(result: Mapping[str, Any]) -> Mapping[str, Any]:
    metadata = result.get("metadata")
    if not isinstance(metadata, Mapping):
        return {}
    usage = metadata.get("usage")
    return usage if isinstance(usage, Mapping) else {}
