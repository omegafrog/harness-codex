import hashlib
from pathlib import Path

import harness_codex.runtime.ddd_candidate_input_integrity_patch as integrity
from harness_codex.runtime.ddd_candidate_baseline_provenance_patch import (
    apply_ddd_candidate_baseline_provenance_patch,
    _baseline_hashes,
)


def _write(root: Path, relative: str, text: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _candidate(change_set_id: str, uc_id: str, hashes: dict[str, str]) -> str:
    lines = [
        "---",
        "status: candidate",
        f"change_set: {change_set_id}",
        f"work_item: {uc_id}",
        "input_hashes:",
    ]
    lines.extend(f"  {key}: {value}" for key, value in hashes.items())
    lines.extend(["---", "# candidate", ""])
    return "\n".join(lines)


def test_requires_present_ubiquitous_hash_and_ignores_architecture_baseline(tmp_path: Path) -> None:
    apply_ddd_candidate_baseline_provenance_patch()
    change_set_id = "CHG-20260707-1"
    uc_id = "UC-001"
    primary = {
        "change_set_document": _write(tmp_path, f"docs/changes/active/{change_set_id}.md", "change\n"),
        "use_case": _write(tmp_path, f"docs/use-cases/{uc_id}/use-case.md", "uc\n"),
        "event_storming": _write(tmp_path, f"docs/use-cases/{uc_id}/event-storming.md", "events\n"),
        "e2e_goal": _write(tmp_path, f"docs/use-cases/{uc_id}/e2e-goal.md", "e2e\n"),
    }
    _write(tmp_path, "docs/design/ubiquitous-language.md", "language\n")
    _write(tmp_path, "ARCHITECTURE.md", "architecture\n")
    hashes = {
        key: "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        for key, path in primary.items()
    }
    candidate = tmp_path / f"docs/use-cases/{uc_id}/ddd-design.md"
    candidate.write_text(_candidate(change_set_id, uc_id, hashes), encoding="utf-8")

    assert integrity._validate_all_input_hashes(tmp_path, change_set_id, uc_id) == "DDD candidate input_hashes is missing `ubiquitous_language`"

    hashes.update(_baseline_hashes(tmp_path))
    assert "architecture_baseline" not in hashes
    candidate.write_text(_candidate(change_set_id, uc_id, hashes), encoding="utf-8")

    assert integrity._validate_all_input_hashes(tmp_path, change_set_id, uc_id) == ""
