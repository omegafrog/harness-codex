from pathlib import Path

import yaml

from harness_codex.cli import main
from harness_codex.runtime.memory import (
    MemoryError,
    load_memory_entry,
    load_memory_entries,
    score_memory_candidate,
    search_memory,
)


def test_memory_index_loads_seed_entries() -> None:
    entries = load_memory_entries(Path("."))

    ids = {entry.id for entry in entries}
    assert "incomplete-plan-contract" in ids
    assert "add-stage-boundary-validator" in ids
    assert "harness-memory-selection-policy" in ids
    assert all(entry.decision_impact for entry in entries if entry.status == "active")


def test_memory_search_returns_active_keyword_matches() -> None:
    results = search_memory(Path("."), "plan contract verification missing")

    assert results
    assert results[0].entry.id == "incomplete-plan-contract"
    assert "plan" in results[0].matched_terms


def test_memory_search_skips_candidate_entries_by_default() -> None:
    assert not search_memory(Path("."), "overly")

    results = search_memory(Path("."), "overly", include_inactive=True)

    assert results[0].entry.id == "strict-validator-blocks-doc-only-change"


def test_memory_score_candidate_thresholds_and_required_fields() -> None:
    candidate = {
        "status": "active",
        "scores": {
            "recurrence_likelihood": 2,
            "decision_impact": 2,
            "rediscovery_cost": 2,
            "stability": 2,
            "evidence": 2,
            "scope_clarity": 2,
            "safety": 2,
        },
        "decision_impact": "Run plan contract validation before implementation.",
        "evidence": ["issue:#360"],
        "applies_to": {"stages": ["plan-writing"]},
    }

    score = score_memory_candidate(candidate)

    assert score.total == 14
    assert score.decision == "active_long_term_memory"
    assert score.required_fields_missing == ()
    assert score.active_ready is True


def test_memory_score_rejects_invalid_scores() -> None:
    try:
        score_memory_candidate({"recurrence_likelihood": 3})
    except MemoryError as error:
        assert "recurrence_likelihood" in str(error)
    else:
        raise AssertionError("invalid score should fail")


def test_active_memory_requires_decision_impact_scope_and_evidence(tmp_path: Path) -> None:
    memory_dir = tmp_path / ".harness/memory/failure-patterns"
    memory_dir.mkdir(parents=True)
    (tmp_path / ".harness/memory/index.yaml").write_text(
        yaml.safe_dump(
            {
                "patterns": [
                    {
                        "id": "missing-evidence",
                        "type": "failure-pattern",
                        "keywords": ["plan"],
                        "path": "failure-patterns/missing-evidence.md",
                        "status": "active",
                        "last_validated": "2026-06-18",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (memory_dir / "missing-evidence.md").write_text(
        "\n".join(
            [
                "---",
                "id: missing-evidence",
                "type: failure-pattern",
                "status: active",
                "decision_impact: Validate before implementation.",
                "applies_to:",
                "  stages:",
                "    - plan-writing",
                "---",
                "# Missing Evidence",
            ]
        ),
        encoding="utf-8",
    )

    try:
        load_memory_entry(tmp_path, "missing-evidence")
    except MemoryError as error:
        assert "evidence" in str(error)
    else:
        raise AssertionError("active memory without evidence should fail")


def test_memory_cli_list_search_and_score(tmp_path: Path, capsys) -> None:
    score_input = tmp_path / "candidate.yaml"
    score_input.write_text(
        yaml.safe_dump(
                {
                    "status": "active",
                    "scores": {
                        "recurrence_likelihood": 2,
                        "decision_impact": 2,
                        "rediscovery_cost": 2,
                        "stability": 2,
                        "evidence": 2,
                        "scope_clarity": 2,
                        "safety": 2,
                    },
                    "decision_impact": "Validate the plan before implementation.",
                    "evidence": ["issue:#360"],
                    "applies_to": {"stages": ["plan-writing"]},
            }
        ),
        encoding="utf-8",
    )

    assert main(["memory", "list"]) == 0
    output = capsys.readouterr().out
    assert "incomplete-plan-contract" in output

    assert main(["memory", "search", "stage boundary validator"]) == 0
    output = capsys.readouterr().out
    assert "add-stage-boundary-validator" in output

    assert main(["memory", "score", str(score_input)]) == 0
    output = capsys.readouterr().out
    assert "active_ready=true" in output
