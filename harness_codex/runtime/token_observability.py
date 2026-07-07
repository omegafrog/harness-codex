"""Collect durable token, prompt, and declared-input metrics from run artifacts."""

from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any, Mapping, Sequence

_ALIASES = {
    "input_tokens": ("input_tokens", "prompt_tokens"),
    "cached_input_tokens": ("cached_input_tokens", "cached_prompt_tokens"),
    "output_tokens": ("output_tokens", "completion_tokens"),
    "reasoning_tokens": ("reasoning_tokens",),
    "total_tokens": ("total_tokens",),
}
_EXCLUSIONS = {
    "execution-minimal": ["ChangeSet body", "workflow definition", "repository source-of-truth previews", "repository settings", "upstream design artifacts"],
    "review-bundle-minimal": ["ChangeSet body", "workflow definition", "repository source-of-truth previews", "repository settings", "full OWASP standards source", "long-term memory", "upstream design artifacts"],
}


def collect_work_item_metrics(*, repo_root: Path, run_id: str, work_item_id: str) -> dict[str, Any]:
    run_dir = repo_root / ".harness/runs" / run_id
    steps_dir = run_dir / "steps"
    steps = [_collect_step(repo_root, path) for path in sorted(steps_dir.iterdir()) if path.is_dir()] if steps_dir.is_dir() else []
    steps = [item for item in steps if item]
    totals = _sum(steps)
    payload = {
        "schema_version": 1,
        "run_id": run_id,
        "work_item_id": work_item_id,
        "usage_source": "provider" if any(item["usage_source"] == "provider" for item in steps) else "estimated",
        "totals": totals,
        "prompt_token_estimate": sum(int(item["prompt_token_estimate"]) for item in steps),
        "prompt_static_context_estimate": sum(int(item["prompt_static_context_estimate"]) for item in steps),
        "provider_calls": sum(int(item["provider_calls"]) for item in steps),
        "review_cache_hits": sum(1 for item in steps if item["review_cache_hit"]),
        "steps": steps,
    }
    _write_json(run_dir / "work-items" / work_item_id / "metrics.json", payload)
    current = _read_json(run_dir / "metrics.json")
    work_items = dict(current.get("work_items") or {})
    work_items[work_item_id] = payload
    _write_json(run_dir / "metrics.json", {"schema_version": 1, "run_id": run_id, "work_items": work_items})
    return payload


def _collect_step(repo_root: Path, step_dir: Path) -> dict[str, Any] | None:
    prompt_path, invocation_path, result_path, stdout_path = (step_dir / "prompt.md", step_dir / "invocation.json", step_dir / "result.json", step_dir / "stdout.txt")
    if not any(path.is_file() for path in (prompt_path, invocation_path, result_path, stdout_path)):
        return None
    invocation, result = _read_json(invocation_path), _read_json(result_path)
    metadata = result.get("metadata") if isinstance(result.get("metadata"), Mapping) else {}
    manifest = _prompt_manifest(_read_text(prompt_path))
    usage = extract_codex_usage(_read_text(stdout_path))
    normalized = usage["usage"]
    usage_source = "provider" if usage["found"] else "estimated"
    if not usage["found"]:
        compact_usage = _compact_provider_usage(result)
        compact_normalized = _normalize(compact_usage)
        if any(value is not None for value in compact_normalized.values()):
            normalized = compact_normalized
            usage_source = "provider"
    profile = str((invocation.get("metadata") or {}).get("prompt_context_profile") or "default")
    record = {
        "schema_version": 1,
        "step_id": invocation.get("step_id") or step_dir.name,
        "agent_id": invocation.get("agent_id"),
        "usage_source": usage_source,
        **normalized,
        "prompt_token_estimate": manifest["total_estimated_tokens"],
        "prompt_static_context_estimate": manifest["static_context_estimated_tokens"],
        "provider_calls": 0 if metadata.get("review_cache_hit") else 1,
        "review_cache_hit": bool(metadata.get("review_cache_hit")),
        "status": result.get("status"),
    }
    _write_json(step_dir / "usage.json", record)
    _write_json(step_dir / "prompt-manifest.json", manifest)
    _write_json(step_dir / "resolved-inputs.json", _resolved_inputs(repo_root, invocation, profile))
    return record


def _compact_provider_usage(result: Mapping[str, Any]) -> Mapping[str, Any]:
    metadata = result.get("metadata")
    if not isinstance(metadata, Mapping):
        return {}
    usage = metadata.get("usage")
    return usage if isinstance(usage, Mapping) else {}


def extract_codex_usage(stdout: str) -> dict[str, Any]:
    candidates: list[dict[str, int | None]] = []
    for line in stdout.splitlines():
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        candidates.extend(_usage_candidates(event))
    if not candidates:
        return {"found": False, "usage": _empty_usage()}
    merged = _empty_usage()
    for candidate in candidates:
        for key, value in candidate.items():
            if value is not None:
                merged[key] = value
    if merged["total_tokens"] is None and all(isinstance(merged[key], int) for key in ("input_tokens", "output_tokens", "reasoning_tokens")):
        merged["total_tokens"] = sum(merged[key] for key in ("input_tokens", "output_tokens", "reasoning_tokens"))
    return {"found": True, "usage": merged}


def _usage_candidates(value: Any) -> list[dict[str, int | None]]:
    stack, records = [value], []
    while stack:
        current = stack.pop()
        if isinstance(current, Mapping):
            source = current.get("usage") if isinstance(current.get("usage"), Mapping) else current
            record = _normalize(source)
            if any(item is not None for item in record.values()):
                records.append(record)
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    return records


def _normalize(mapping: Mapping[str, Any]) -> dict[str, int | None]:
    result = _empty_usage()
    for destination, aliases in _ALIASES.items():
        result[destination] = next((mapping[key] for key in aliases if isinstance(mapping.get(key), int) and mapping[key] >= 0), None)
    return result


def _empty_usage() -> dict[str, int | None]:
    return {key: None for key in _ALIASES}


def _prompt_manifest(text: str) -> dict[str, Any]:
    matches = list(re.finditer(r"(?m)^##\s+(.+?)\s*$", text))
    sections = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        body = text[match.start():end]
        sections.append({"name": match.group(1), "chars": len(body), "utf8_bytes": len(body.encode("utf-8")), "estimated_tokens": _estimate(body), "static_context": any(token in match.group(1).lower() for token in ("repository source", "workflow", "repository settings", "changeset", "long-term memory"))})
    return {"schema_version": 1, "sections": sections, "total_chars": len(text), "total_utf8_bytes": len(text.encode("utf-8")), "total_estimated_tokens": _estimate(text), "static_context_estimated_tokens": sum(section["estimated_tokens"] for section in sections if section["static_context"])}


def _resolved_inputs(repo_root: Path, invocation: Mapping[str, Any], profile: str) -> dict[str, Any]:
    rows = []
    for raw in invocation.get("inputs", []) if isinstance(invocation.get("inputs"), list) else []:
        path = Path(str(raw)); absolute = path if path.is_absolute() else repo_root / path
        rows.append({"path": str(path), "required": True, "reason": "workflow-declared input", "bytes": absolute.stat().st_size if absolute.is_file() else None, "estimated_tokens": _estimate(_read_text(absolute)) if absolute.is_file() else None})
    return {"schema_version": 1, "profile": profile, "inputs": rows, "excluded_inputs": [{"description": value, "reason": f"{profile} profile excludes this context"} for value in _EXCLUSIONS.get(profile, [])]}


def _sum(records: list[Mapping[str, Any]]) -> dict[str, int | None]:
    result: dict[str, int | None] = {}
    for key in _ALIASES:
        values = [record.get(key) for record in records if isinstance(record.get(key), int)]
        result[key] = sum(values) if values else None
    return result


def _estimate(text: str) -> int:
    return math.ceil(len(text) / 4) if text else 0


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--work-item", required=True)
    args = parser.parse_args(argv)
    collect_work_item_metrics(repo_root=Path(args.repo_root).resolve(), run_id=args.run_id, work_item_id=args.work_item)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
