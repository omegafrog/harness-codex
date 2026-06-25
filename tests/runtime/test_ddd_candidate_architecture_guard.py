from __future__ import annotations

from pathlib import Path

import harness_codex.runtime  # installs candidate DDD scope guard
from harness_codex.runtime import harvest_ui


CANDIDATE_DDD = """# UC-001. DDD Candidate Design

## Impact Assessment
|Element Type|Element|Status|Baseline Evidence|Event Storming Evidence|
|---|---|---|---|---|
|Entity|Note|new|No prior model|Save Note command|

## Entity / Value Objects
|Entity|Attributes / VOs|Status|Previous Definition|Proposed Definition|Evidence|
|---|---|---|---|---|---|
|Note|id: NoteId (required)|new|-|id: NoteId|Save Note command|
"""


def test_candidate_ddd_substep_cannot_delete_canonical_architecture(
    tmp_path: Path, monkeypatch
) -> None:
    architecture = tmp_path / "ARCHITECTURE.md"
    architecture.write_text("# Canonical Architecture\n\n- preserved\n", encoding="utf-8")
    session = {
        "ddd_architecture": {
            "uc_ids": ["UC-001"],
            "items": {
                "UC-001": {
                    "status": "pending",
                    "steps": {
                        "entity_vo": {
                            "status": "pending",
                            "current_question": None,
                            "error": "",
                        }
                    },
                }
            },
            "current_uc": "UC-001",
            "current_step": "entity_vo",
            "completed_count": 0,
            "complete": False,
            "status": "pending",
        }
    }

    def complete_candidate(*args, **kwargs):
        output = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(CANDIDATE_DDD, encoding="utf-8")
        return {"status": "complete"}

    monkeypatch.setattr(harvest_ui, "_run_ddd_architecture", complete_candidate)

    harvest_ui._advance_ddd_architecture(
        tmp_path,
        session,
        "CHG-20260625-803",
        uc_id="UC-001",
        step_id="entity_vo",
    )

    assert architecture.read_text(encoding="utf-8") == "# Canonical Architecture\n\n- preserved\n"
