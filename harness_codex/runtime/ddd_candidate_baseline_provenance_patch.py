"""Require source hashes for DDD candidate-owned baselines when present."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


_BASELINE_PATHS = {
    "ubiquitous_language": Path("docs/design/ubiquitous-language.md"),
}


def apply_ddd_candidate_baseline_provenance_patch() -> None:
    """Extend candidate provenance without weakening required slice hashes."""

    import harness_codex.runtime.ddd_candidate_input_integrity_patch as integrity
    import harness_codex.runtime.harvest_ui as ui

    if getattr(integrity, "_ddd_candidate_baseline_provenance_patch_applied", False):
        return

    original_validate = integrity._validate_all_input_hashes
    original_expected = integrity._expected_hashes
    original_contract = ui._ddd_run_all_contract

    def expected_hashes(root: Path, change_set_id: str, uc_id: str) -> dict[str, str]:
        hashes = dict(original_expected(root, change_set_id, uc_id))
        hashes.update(_baseline_hashes(root))
        return hashes

    def validate_all(root: Path, change_set_id: str, uc_id: str) -> str:
        error = original_validate(root, change_set_id, uc_id)
        if error:
            return error
        try:
            text = (root / "docs" / "use-cases" / uc_id / "ddd-design.md").read_text(
                encoding="utf-8"
            )
        except OSError:
            return f"DDD candidate is unreadable for baseline provenance: {uc_id}"
        declared = _declared_baseline_hashes(text)
        for key, expected in _baseline_hashes(root).items():
            if key not in declared:
                return f"DDD candidate input_hashes is missing `{key}`"
            if declared[key] != expected:
                return f"DDD candidate input hash mismatch for `{key}`"
        return ""

    def candidate_contract(change_set_id: str, targets, state) -> str:
        return (
            original_contract(change_set_id, targets, state).rstrip()
            + "\nWhen present, also hash `docs/design/ubiquitous-language.md` as "
            + "`ubiquitous_language`. Do not read or hash `ARCHITECTURE.md` in the "
            + "candidate DDD stage; shared architecture reconciliation belongs to "
            + "`ddd-design-integration`.\n"
        )

    integrity._expected_hashes = expected_hashes
    integrity._validate_all_input_hashes = validate_all
    ui._ddd_run_all_contract = candidate_contract
    integrity._ddd_candidate_baseline_provenance_patch_applied = True


def _baseline_hashes(root: Path) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for key, relative in _BASELINE_PATHS.items():
        path = root / relative
        if path.is_file() and not path.is_symlink():
            hashes[key] = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def _declared_baseline_hashes(text: str) -> dict[str, str]:
    front = re.match(r"\A---\n(?P<body>.*?)\n---\n?", text, flags=re.DOTALL)
    if front is None:
        return {}
    block = re.search(
        r"(?m)^input_hashes:[ \t]*\n(?P<body>(?:^[ \t]+.*(?:\n|$))*)",
        front.group("body"),
    )
    if block is None:
        return {}
    values: dict[str, str] = {}
    for key in _BASELINE_PATHS:
        match = re.search(rf"(?m)^\s+{re.escape(key)}:\s*(\S+)\s*$", block.group("body"))
        if match is not None:
            values[key] = match.group(1).strip("'\"")
    return values
