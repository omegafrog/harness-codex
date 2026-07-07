"""Fail DDD integration when a referenced candidate is stale against its sources."""

from __future__ import annotations

import json
from pathlib import Path


def apply_ddd_integration_candidate_provenance_patch() -> None:
    """Add source-provenance checks to ChangeSet-level DDD integration."""

    import harness_codex.runtime.ddd_integration as integration
    from harness_codex.runtime.ddd_candidate_input_integrity_patch import (
        _validate_all_input_hashes,
    )

    original_verify = integration.verify_ddd_integration
    if getattr(original_verify, "_ddd_candidate_provenance_patch", False):
        return

    def verify_ddd_integration(repo_root: Path, *, change_set_id: str):
        valid, problems = original_verify(repo_root, change_set_id=change_set_id)
        if not valid:
            return valid, problems

        json_path = repo_root / integration.integration_paths(change_set_id)[1]
        try:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return False, tuple([*problems, f"unreadable integration contract: {json_path}"])
        if payload.get("status") != "accepted":
            return valid, problems

        candidate_problems: list[str] = []
        candidates = payload.get("candidate_inputs")
        for item in candidates if isinstance(candidates, list) else []:
            if not isinstance(item, dict):
                continue
            uc_id = item.get("uc_id")
            relative = item.get("path")
            if not isinstance(uc_id, str) or not isinstance(relative, str):
                continue
            expected = Path("docs") / "use-cases" / uc_id / "ddd-design.md"
            if Path(relative) != expected:
                candidate_problems.append(
                    f"candidate input path must be {expected}: {relative}"
                )
                continue
            error = _validate_all_input_hashes(repo_root, change_set_id, uc_id)
            if error:
                candidate_problems.append(f"candidate provenance invalid for {uc_id}: {error}")

        return not candidate_problems, tuple([*problems, *candidate_problems])

    verify_ddd_integration._ddd_candidate_provenance_patch = True
    integration.verify_ddd_integration = verify_ddd_integration
