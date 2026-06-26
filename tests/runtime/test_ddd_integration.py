from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.ddd_integration import integration_paths, sha256_file, verify_ddd_integration


def test_accepted_integration_is_current(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-001"
    candidate = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
    candidate.parent.mkdir(parents=True)
    candidate.write_text("candidate", encoding="utf-8")
    markdown, contract = integration_paths(change_set_id)
    (tmp_path / markdown).parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / markdown).write_text("integration", encoding="utf-8")
    (tmp_path / contract).write_text(
        json.dumps(
            {
                "status": "accepted",
                "change_set": change_set_id,
                "candidate_inputs": [
                    {
                        "uc_id": "UC-001",
                        "path": "docs/use-cases/UC-001/ddd-design.md",
                        "hash": sha256_file(candidate),
                    }
                ],
                "coverage": {"UC-001": "accepted"},
                "canonical_models": [
                    {
                        "bounded_context": "Notification",
                        "aggregates": [
                            {"name": "Notification", "provenance": ["UC-001"]}
                        ],
                    }
                ],
                "blocked_conflicts": [],
            }
        ),
        encoding="utf-8",
    )

    passed, problems = verify_ddd_integration(tmp_path, change_set_id=change_set_id)

    assert passed
    assert problems == ()


def test_accepted_integration_accepts_rich_agent_schema(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-001"
    candidate = tmp_path / "docs/use-cases/UC-030/ddd-design.md"
    candidate.parent.mkdir(parents=True)
    candidate.write_text("candidate", encoding="utf-8")
    markdown, contract = integration_paths(change_set_id)
    (tmp_path / markdown).parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / markdown).write_text("integration", encoding="utf-8")
    (tmp_path / contract).write_text(
        json.dumps(
            {
                "status": "accepted",
                "change_set": change_set_id,
                "candidate_inputs": [
                    {
                        "uc_id": "UC-030",
                        "path": "docs/use-cases/UC-030/ddd-design.md",
                        "sha256": sha256_file(candidate),
                    }
                ],
                "coverage": [
                    {
                        "uc_id": "UC-030",
                        "accepted": True,
                        "candidate_path": "docs/use-cases/UC-030/ddd-design.md",
                    }
                ],
                "canonical_models": {
                    "bounded_contexts": [
                        {
                            "name": "Notification Management Context",
                            "aggregates": ["NotificationAggregate"],
                        }
                    ],
                    "aggregates": [
                        {
                            "name": "NotificationAggregate",
                            "bounded_context": "Notification Management Context",
                            "provenance": ["UC-030"],
                        }
                    ],
                },
                "blocked_conflicts": [],
            }
        ),
        encoding="utf-8",
    )

    passed, problems = verify_ddd_integration(tmp_path, change_set_id=change_set_id)

    assert passed
    assert problems == ()


def test_integration_detects_stale_candidate(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-001"
    candidate = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
    candidate.parent.mkdir(parents=True)
    candidate.write_text("old", encoding="utf-8")
    markdown, contract = integration_paths(change_set_id)
    (tmp_path / markdown).parent.mkdir(parents=True, exist_ok=True)
    (tmp_path / markdown).write_text("integration", encoding="utf-8")
    (tmp_path / contract).write_text(
        json.dumps(
            {
                "status": "accepted",
                "change_set": change_set_id,
                "candidate_inputs": [{"uc_id": "UC-001", "path": "docs/use-cases/UC-001/ddd-design.md", "hash": sha256_file(candidate)}],
                "coverage": {"UC-001": "accepted"},
                "canonical_models": [{"bounded_context": "Notification", "aggregates": [{"name": "Notification", "provenance": ["UC-001"]}]}],
                "blocked_conflicts": [],
            }
        ),
        encoding="utf-8",
    )
    candidate.write_text("new", encoding="utf-8")

    passed, problems = verify_ddd_integration(tmp_path, change_set_id=change_set_id)

    assert not passed
    assert any("stale candidate input hash" in problem for problem in problems)
