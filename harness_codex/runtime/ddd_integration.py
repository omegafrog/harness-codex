"""ChangeSet-level DDD integration contract validation."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path


INTEGRATION_STATUSES = frozenset({"accepted", "not_applicable"})


def integration_paths(change_set_id: str) -> tuple[Path, Path]:
    root = Path("docs/changes/active")
    return root / f"{change_set_id}.ddd-integration.md", root / f"{change_set_id}.ddd-integration.json"


def sha256_file(path: Path) -> str:
    return f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"


def verify_ddd_integration(repo_root: Path, *, change_set_id: str) -> tuple[bool, tuple[str, ...]]:
    markdown_path, json_path = integration_paths(change_set_id)
    markdown_absolute = repo_root / markdown_path
    json_absolute = repo_root / json_path
    problems: list[str] = []

    if not markdown_absolute.exists():
        problems.append(f"missing output: {markdown_path}")
    elif not markdown_absolute.read_text(encoding="utf-8").strip():
        problems.append(f"empty output: {markdown_path}")

    if not json_absolute.exists():
        problems.append(f"missing output: {json_path}")
        return False, tuple(problems)

    try:
        payload = json.loads(json_absolute.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        return False, tuple([*problems, f"invalid JSON in {json_path}: {exc.msg}"])

    if not isinstance(payload, dict):
        return False, tuple([*problems, f"integration contract must be an object: {json_path}"])
    if payload.get("change_set") != change_set_id:
        problems.append(f"integration change_set mismatch in {json_path}")

    status = payload.get("status")
    if status not in INTEGRATION_STATUSES:
        return False, tuple([*problems, "integration status must be accepted or not_applicable"])

    candidates = payload.get("candidate_inputs")
    if not isinstance(candidates, list):
        return False, tuple([*problems, "candidate_inputs must be a list"])

    if status == "not_applicable":
        if candidates:
            problems.append("not_applicable integration must not list candidate inputs")
        if not isinstance(payload.get("not_applicable_reason"), str):
            problems.append("not_applicable integration requires not_applicable_reason")
        return not problems, tuple(problems)

    if not candidates:
        problems.append("accepted integration requires at least one candidate input")

    candidate_ids: set[str] = set()
    for candidate in candidates:
        if not isinstance(candidate, dict):
            problems.append("candidate_inputs entries must be objects")
            continue
        uc_id = candidate.get("uc_id")
        relative_path = candidate.get("path")
        expected_hash = candidate.get("hash") or candidate.get("sha256")
        if not isinstance(uc_id, str) or not uc_id:
            problems.append("candidate input is missing uc_id")
            continue
        candidate_ids.add(uc_id)
        if not isinstance(relative_path, str) or not isinstance(expected_hash, str):
            problems.append(f"candidate input {uc_id} is missing path or hash")
            continue
        candidate_path = repo_root / relative_path
        if not candidate_path.exists():
            problems.append(f"missing candidate input: {relative_path}")
        elif sha256_file(candidate_path) != expected_hash:
            problems.append(f"stale candidate input hash for {relative_path}")

    models = _canonical_model_entries(payload.get("canonical_models"))
    if not models:
        problems.append("accepted integration requires canonical_models")
    else:
        provenance: set[str] = set()
        for model in models:
            if not isinstance(model, dict) or not isinstance(model.get("bounded_context"), str):
                problems.append("canonical model requires bounded_context")
                continue
            aggregates = model.get("aggregates")
            if not isinstance(aggregates, list) or not aggregates:
                problems.append("canonical model requires aggregates")
                continue
            for aggregate in aggregates:
                if not isinstance(aggregate, dict) or not isinstance(aggregate.get("name"), str):
                    problems.append("aggregate requires name")
                    continue
                sources = aggregate.get("provenance")
                if not isinstance(sources, list) or not all(isinstance(source, str) for source in sources):
                    problems.append("aggregate provenance must be a list of work item IDs")
                    continue
                provenance.update(sources)
        missing = sorted(candidate_ids - provenance)
        if missing:
            problems.append("candidate inputs not represented in canonical provenance: " + ", ".join(missing))

    coverage = _coverage_mapping(payload.get("coverage"))
    if coverage is None:
        problems.append("accepted integration requires coverage mapping")
    else:
        unresolved = sorted(uc_id for uc_id in candidate_ids if coverage.get(uc_id) != "accepted")
        if unresolved:
            problems.append("candidate inputs are not accepted: " + ", ".join(unresolved))

    blocked_conflicts = payload.get("blocked_conflicts", [])
    if not isinstance(blocked_conflicts, list):
        problems.append("blocked_conflicts must be a list")
    elif blocked_conflicts:
        problems.append("accepted integration cannot contain blocked conflicts")

    return not problems, tuple(problems)


def _canonical_model_entries(value: object) -> list[dict[str, object]]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    if not isinstance(value, dict):
        return []

    bounded_contexts = value.get("bounded_contexts")
    aggregates = value.get("aggregates")
    if not isinstance(bounded_contexts, list) or not isinstance(aggregates, list):
        return []

    entries: list[dict[str, object]] = []
    for context in bounded_contexts:
        if not isinstance(context, dict):
            continue
        context_name = context.get("name")
        if not isinstance(context_name, str) or not context_name:
            continue
        owned_names = context.get("aggregates")
        if not isinstance(owned_names, list):
            owned_names = context.get("owned_aggregates")
        selected = []
        if isinstance(owned_names, list):
            names = {name for name in owned_names if isinstance(name, str)}
            selected = [
                aggregate
                for aggregate in aggregates
                if isinstance(aggregate, dict)
                and isinstance(aggregate.get("name"), str)
                and aggregate.get("name") in names
            ]
        if not selected:
            selected = [
                aggregate
                for aggregate in aggregates
                if isinstance(aggregate, dict)
                and aggregate.get("bounded_context") == context_name
            ]
        if selected:
            entries.append({"bounded_context": context_name, "aggregates": selected})

    if entries:
        return entries

    return [
        {"bounded_context": "canonical", "aggregates": aggregates}
    ]


def _coverage_mapping(value: object) -> dict[str, str] | None:
    if isinstance(value, dict):
        return {str(key): str(status) for key, status in value.items()}
    if not isinstance(value, list):
        return None

    coverage: dict[str, str] = {}
    for item in value:
        if not isinstance(item, dict):
            continue
        uc_id = item.get("uc_id")
        if not isinstance(uc_id, str) or not uc_id:
            continue
        accepted = item.get("accepted")
        status = item.get("status")
        if accepted is True:
            coverage[uc_id] = "accepted"
        elif isinstance(status, str):
            coverage[uc_id] = status
    return coverage
