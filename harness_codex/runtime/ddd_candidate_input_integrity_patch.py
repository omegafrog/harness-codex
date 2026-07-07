"""Validate every source artifact declared by a DDD candidate."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Mapping


_INPUT_HASH_KEYS = (
    "change_set_document",
    "use_case",
    "event_storming",
    "e2e_goal",
)


def apply_ddd_candidate_input_integrity_patch() -> None:
    """Reject candidates stale against any primary DDD input.

    The base candidate validator already checks the document shape and the
    event-storming hash. This patch extends that check to every declared source and
    records the accepted input fingerprint in the runtime receipt without mutating
    the agent-authored front matter.
    """

    import harness_codex.runtime.ddd_candidate_efficiency_patch as candidate
    import harness_codex.runtime.harvest_ui as ui

    if getattr(candidate, "_ddd_candidate_input_integrity_patch_applied", False):
        return

    original_validate = candidate._validate_complete_candidate
    original_receipt = candidate._write_candidate_receipt
    original_contract = ui._ddd_run_all_contract

    def validate_complete(root: Path, change_set_id: str, uc_id: str) -> str:
        error = original_validate(root, change_set_id, uc_id)
        if error:
            return error
        return _validate_all_input_hashes(root, change_set_id, uc_id)

    def write_receipt(root: Path, change_set_id: str, uc_id: str, *, status: str) -> None:
        original_receipt(root, change_set_id, uc_id, status=status)
        path = root / ".harness" / "contracts" / change_set_id / uc_id / "ddd-candidate.runtime.json"
        payload = _read_json(path)
        if not payload:
            return
        payload["input_hashes"] = _expected_hashes(root, change_set_id, uc_id)
        _atomic_write_json(path, payload)

    def candidate_contract(change_set_id: str, targets, state) -> str:
        return (
            original_contract(change_set_id, targets, state).rstrip()
            + "\n\n"
            + "Candidate front matter input_hashes must include exact SHA-256 values for: "
            + "change_set_document, use_case, event_storming, e2e_goal. "
            + "Use the current bytes of the four declared inputs; do not reuse stale hashes.\n"
        )

    candidate._validate_complete_candidate = validate_complete
    candidate._write_candidate_receipt = write_receipt
    ui._ddd_run_all_contract = candidate_contract
    candidate._ddd_candidate_input_integrity_patch_applied = True


def _source_paths(change_set_id: str, uc_id: str) -> dict[str, Path]:
    return {
        "change_set_document": Path("docs") / "changes" / "active" / f"{change_set_id}.md",
        "use_case": Path("docs") / "use-cases" / uc_id / "use-case.md",
        "event_storming": Path("docs") / "use-cases" / uc_id / "event-storming.md",
        "e2e_goal": Path("docs") / "use-cases" / uc_id / "e2e-goal.md",
    }


def _expected_hashes(root: Path, change_set_id: str, uc_id: str) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for key, relative in _source_paths(change_set_id, uc_id).items():
        absolute = root / relative
        if absolute.is_file():
            hashes[key] = "sha256:" + hashlib.sha256(absolute.read_bytes()).hexdigest()
    return hashes


def _validate_all_input_hashes(root: Path, change_set_id: str, uc_id: str) -> str:
    candidate_path = root / "docs" / "use-cases" / uc_id / "ddd-design.md"
    try:
        text = candidate_path.read_text(encoding="utf-8")
    except OSError:
        return f"DDD candidate is unreadable: {candidate_path}"

    declared = _declared_input_hashes(text)
    expected = _expected_hashes(root, change_set_id, uc_id)
    for key in _INPUT_HASH_KEYS:
        source = _source_paths(change_set_id, uc_id)[key]
        if key not in expected:
            return f"DDD candidate is missing required input artifact: {source}"
        if key not in declared:
            return f"DDD candidate input_hashes is missing `{key}`"
        if declared[key] != expected[key]:
            return f"DDD candidate input hash mismatch for `{key}`"
    return ""


def _declared_input_hashes(text: str) -> dict[str, str]:
    front = _front_matter(text)
    if not front:
        return {}
    block = re.search(r"(?ms)^input_hashes:\s*\n(?P<body>(?:^[ \t]+.*(?:\n|$))*)", front)
    if block is None:
        return {}
    values: dict[str, str] = {}
    body = block.group("body")
    for key in _INPUT_HASH_KEYS:
        match = re.search(rf"(?m)^\s+{re.escape(key)}:\s*(\S+)\s*$", body)
        if match is not None:
            values[key] = match.group(1).strip("'\"")
    return values


def _front_matter(text: str) -> str:
    match = re.match(r"\A---\n(?P<body>.*?)\n---\n?", text, flags=re.DOTALL)
    return match.group("body") if match else ""


def _read_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _atomic_write_json(path: Path, payload: Mapping) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temporary.replace(path)
