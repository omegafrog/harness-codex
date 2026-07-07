import hashlib
from pathlib import Path

from harness_codex.runtime.ddd_integration_candidate_provenance_patch import (
    _candidate_provenance_problems,
)


def _write_sources(root: Path, change_set_id: str, uc_id: str) -> dict[str, str]:
    paths = {
        "change_set_document": root / "docs" / "changes" / "active" / f"{change_set_id}.md",
        "use_case": root / "docs" / "use-cases" / uc_id / "use-case.md",
        "event_storming": root / "docs" / "use-cases" / uc_id / "event-storming.md",
        "e2e_goal": root / "docs" / "use-cases" / uc_id / "e2e-goal.md",
    }
    for path in paths.values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(path.name + "\n", encoding="utf-8")
    return {
        key: "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        for key, path in paths.items()
    }


def _candidate(change_set_id: str, uc_id: str, hashes: dict[str, str]) -> str:
    return f"""---
status: candidate
change_set: {change_set_id}
work_item: {uc_id}
input_hashes:
  change_set_document: {hashes['change_set_document']}
  use_case: {hashes['use_case']}
  event_storming: {hashes['event_storming']}
  e2e_goal: {hashes['e2e_goal']}
---
# candidate
"""


def test_integration_rejects_stale_candidate_provenance(tmp_path: Path) -> None:
    change_set_id = "CHG-20260707-1"
    uc_id = "UC-001"
    hashes = _write_sources(tmp_path, change_set_id, uc_id)
    candidate = tmp_path / "docs" / "use-cases" / uc_id / "ddd-design.md"
    hashes["use_case"] = "sha256:" + "0" * 64
    candidate.write_text(_candidate(change_set_id, uc_id, hashes), encoding="utf-8")

    problems = _candidate_provenance_problems(
        tmp_path,
        change_set_id,
        {
            "candidate_inputs": [
                {
                    "uc_id": uc_id,
                    "path": f"docs/use-cases/{uc_id}/ddd-design.md",
                }
            ]
        },
    )

    assert problems == ["candidate provenance invalid for UC-001: DDD candidate input hash mismatch for `use_case`"]


def test_integration_rejects_candidate_path_substitution(tmp_path: Path) -> None:
    problems = _candidate_provenance_problems(
        tmp_path,
        "CHG-20260707-1",
        {
            "candidate_inputs": [
                {"uc_id": "UC-001", "path": "docs/other.md"},
            ]
        },
    )

    assert problems == ["candidate input path must be docs/use-cases/UC-001/ddd-design.md: docs/other.md"]
