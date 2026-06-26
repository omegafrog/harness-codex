from __future__ import annotations

import json
from pathlib import Path

import pytest

import harness_codex.runtime  # installs canonical dashboard/CLI bridges
from harness_codex import cli
from harness_codex.runtime.dashboard_runtime_state import (
    assert_canonical_stage_gate,
    load_canonical_change_set_state,
    sync_change_set_runtime_state,
)
from harness_codex.runtime.ddd_integration import integration_paths, sha256_file
from harness_codex.runtime.document_dashboard import (
    read_dashboard_document,
    save_dashboard_document,
)
from harness_codex.runtime.procedure_stages import (
    PROCEDURE_STAGES,
    parse_procedure_stage_rows,
    procedure_stage,
    render_initial_changeset,
    update_changeset_stage_status,
)
from harness_codex.runtime.state import RunStateStore


DDD_DESIGN = """---
status: candidate
change_set: <CHG-ID>
work_item: UC-001
---

# UC-001. DDD Candidate Design

## Impact Assessment
|Element Type|Element|Status|Baseline Evidence|Event Storming Evidence|
|---|---|---|---|---|
|Entity|Note|new|No prior model|Save Note command|

## Entity / Value Objects
|Entity|Attributes / VOs|Status|Previous Definition|Proposed Definition|Evidence|
|---|---|---|---|---|---|
|Note|id: NoteId (required); content: Content (required)|new|-|id: NoteId; content: Content|Save Note command|

## Behaviors
|Owner / Service|Signature|Participants|Placement|Policy Evidence|
|---|---|---|---|---|
|Note|save(Content content)|Note|entity method|Save Note policy|

## Application Flow
|Application Service|Signature|Description|Calls|Evidence|
|---|---|---|---|---|
|SaveNoteApplicationService|save(NoteId id, Content content)|Loads, invokes the aggregate, and persists.|Note.save|Save Note command|

## Aggregates
|Aggregate|Aggregate Root|Members|Atomic Invariant|Evidence|
|---|---|---|---|---|
|Note|Note|Note, NoteId, Content|A saved note has non-empty content.|Note Saved event|

## Bounded Contexts
|Bounded Context|Owned Aggregates / Entities|Boundary Reason|Communication Type|Target BC|Evidence|
|---|---|---|---|---|---|
|Notes|Note|Owns note lifecycle|internal_http|Search|Save Note command|

## Architecture Visualization

<!-- harness:ddd-visualization:entity_vo:start -->
### Entity / Value Objects

```mermaid
classDiagram
    class Note {
        <<entity>>
        +NoteId id
        +Content content
    }
```
<!-- harness:ddd-visualization:entity_vo:end -->
"""


def _write_change_set(root: Path, change_set_id: str) -> Path:
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title="Canonical gate unification",
            request_summary="Every procedure stage must share one gate state.",
        )
        + """
## 5. Affected Use Cases

|UC ID|Use Case Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|
|`UC-001`|Save Note|add|`docs/use-cases/UC-001`|ready|
""",
        encoding="utf-8",
    )
    return path


def _write_valid_ddd_integration(root: Path, change_set_id: str) -> None:
    candidate = root / "docs/use-cases/UC-001/ddd-design.md"
    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_text(DDD_DESIGN.replace("<CHG-ID>", change_set_id), encoding="utf-8")
    markdown_path, json_path = integration_paths(change_set_id)
    (root / markdown_path).parent.mkdir(parents=True, exist_ok=True)
    (root / markdown_path).write_text("# DDD Integration\n", encoding="utf-8")
    (root / json_path).write_text(
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
                        "bounded_context": "Notes",
                        "aggregates": [
                            {"name": "Note", "provenance": ["UC-001"]}
                        ],
                    }
                ],
                "blocked_conflicts": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def _force_table_status(path: Path, stage_id: str, status: str) -> None:
    text = path.read_text(encoding="utf-8")
    path.write_text(
        update_changeset_stage_status(
            text,
            stage=procedure_stage(stage_id),
            status=status,
            notes="manual table drift",
        ),
        encoding="utf-8",
    )


def _record_statuses(root: Path, change_path: Path, stage_ids: list[str], status: str) -> None:
    for stage_id in stage_ids:
        cli._record_procedure_stage_status(
            root,
            change_path.relative_to(root),
            procedure_stage(stage_id),
            status,
            f"{stage_id} {status}",
        )


def test_every_procedure_gate_uses_canonical_state_not_the_changeset_table(tmp_path: Path) -> None:
    stage_ids = [stage.stage_id for stage in PROCEDURE_STAGES]

    for index, target_stage_id in enumerate(stage_ids[1:], start=1):
        root = tmp_path / target_stage_id
        root.mkdir()
        change_set_id = f"CHG-20260625-{700 + index}"
        change_path = _write_change_set(root, change_set_id)
        _write_valid_ddd_integration(root, change_set_id)
        upstream_stage_ids = stage_ids[:index]
        _record_statuses(root, change_path, upstream_stage_ids, "verified")

        # A table-only regression must not close a gate that the canonical RunState
        # already verified.
        for stage_id in upstream_stage_ids:
            _force_table_status(change_path, stage_id, "pending")
        assert_canonical_stage_gate(root, change_set_id, target_stage_id)

        # Conversely, a table-only "verified" edit must not reopen a canonical
        # stale gate.  This is exercised for every procedure-step boundary.
        blocking_stage_id = upstream_stage_ids[-1]
        _record_statuses(root, change_path, [blocking_stage_id], "stale")
        _force_table_status(change_path, blocking_stage_id, "verified")
        with pytest.raises(ValueError, match=blocking_stage_id):
            assert_canonical_stage_gate(root, change_set_id, target_stage_id)


def test_ddd_substeps_are_projected_to_canonical_state_without_unlocking_early(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-801"
    _write_change_set(tmp_path, change_set_id)
    candidate = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
    candidate.parent.mkdir(parents=True, exist_ok=True)
    candidate.write_text(DDD_DESIGN.replace("<CHG-ID>", change_set_id), encoding="utf-8")

    steps = {
        "entity_vo": {"status": "complete"},
        "behaviors": {"status": "needs_input"},
        "application_flow": {"status": "pending"},
        "aggregates": {"status": "pending"},
        "bounded_contexts": {"status": "pending"},
    }
    session = {
        "ddd_architecture": {
            "uc_ids": ["UC-001"],
            "items": {"UC-001": {"steps": steps}},
            "complete": False,
        }
    }

    partial = sync_change_set_runtime_state(tmp_path, change_set_id, session)
    substeps = partial.decision_results["dashboard_ddd_substep_results"]["UC-001"]
    assert substeps["entity_vo"] == {"status": "verified", "ui_status": "complete"}
    assert substeps["behaviors"] == {"status": "blocked", "ui_status": "needs_input"}
    assert "ddd-architecture-definition" not in {
        artifact.stage for artifact in partial.artifact_states
    }

    for step in steps.values():
        step["status"] = "complete"
    session["ddd_architecture"]["complete"] = True
    completed = sync_change_set_runtime_state(tmp_path, change_set_id, session)
    assert completed.decision_results["dashboard_ddd_substep_results"]["UC-001"][
        "bounded_contexts"
    ]["status"] == "verified"
    ddd_stage = next(
        artifact
        for artifact in completed.artifact_states
        if artifact.stage == "ddd-architecture-definition"
    )
    assert ddd_stage.accepted is True


def test_accepted_stage_artifact_overrides_stale_blocked_decision_result(
    tmp_path: Path,
) -> None:
    change_set_id = "CHG-20260625-803"
    change_path = _write_change_set(tmp_path, change_set_id)
    _write_valid_ddd_integration(tmp_path, change_set_id)
    technical_decisions_path = (
        tmp_path / "docs/use-cases/UC-001/technical-decisions.md"
    )
    technical_decisions_path.parent.mkdir(parents=True, exist_ok=True)
    technical_decisions_path.write_text(
        "# Technical Decisions\n\n|Item|Value|\n|---|---|\n|Approval Status|approved|\n",
        encoding="utf-8",
    )
    _record_statuses(
        tmp_path,
        change_path,
        [
            "requirements-definition",
            "ubiquitous-language-definition",
            "use-case-definition",
            "event-storming",
            "ddd-architecture-definition",
            "ddd-design-integration",
        ],
        "verified",
    )
    cli._record_procedure_stage_status(
        tmp_path,
        change_path.relative_to(tmp_path),
        procedure_stage("technical-decisions"),
        "blocked",
        "content review needs user input",
    )

    with pytest.raises(ValueError, match="technical-decisions"):
        assert_canonical_stage_gate(
            tmp_path,
            change_set_id,
            "design-visualization",
            uc_id="UC-001",
        )

    run_id = f"changeset-state-{change_set_id}"
    RunStateStore(tmp_path).save_artifact_acceptance(
        run_id,
        "technical-decisions",
        Path("docs/use-cases/UC-001/technical-decisions.md"),
    )

    assert_canonical_stage_gate(
        tmp_path,
        change_set_id,
        "design-visualization",
        uc_id="UC-001",
    )


def test_dashboard_ddd_edit_stales_integration_and_downstream_in_canonical_state(
    tmp_path: Path,
) -> None:
    change_set_id = "CHG-20260625-802"
    change_path = _write_change_set(tmp_path, change_set_id)
    scoped_root = tmp_path / ".harness/ui/change-sets" / change_set_id
    ddd_path = scoped_root / "docs/use-cases/UC-001/ddd-design.md"
    ddd_path.parent.mkdir(parents=True, exist_ok=True)
    ddd_path.write_text(DDD_DESIGN.replace("<CHG-ID>", change_set_id), encoding="utf-8")
    step_ids = ("entity_vo", "behaviors", "application_flow", "aggregates", "bounded_contexts")
    session = {
        "ddd_architecture": {
            "uc_ids": ["UC-001"],
            "items": {
                "UC-001": {
                    "status": "complete",
                    "steps": {step_id: {"status": "complete"} for step_id in step_ids},
                }
            },
            "complete": True,
        }
    }
    session_path = scoped_root / "harvest-session.json"
    session_path.write_text(json.dumps(session), encoding="utf-8")
    _record_statuses(
        tmp_path,
        change_path,
        [stage.stage_id for stage in PROCEDURE_STAGES],
        "verified",
    )

    document_id = f"ddd-design:{change_set_id}:UC-001"
    loaded = read_dashboard_document(tmp_path, document_id)
    save_dashboard_document(
        tmp_path,
        document_id,
        content=loaded["content"].replace("A saved note has non-empty content.", "A note keeps non-empty content."),
        revision=loaded["revision"],
    )

    state = load_canonical_change_set_state(tmp_path, change_set_id)
    assert state is not None
    statuses = state.decision_results["procedure_stage_results"]
    expected_stale = {
        "ddd-design-integration",
        "technical-decisions",
        "design-visualization",
        "plan-writing",
        "implementation",
        "change-set-pr",
    }
    assert {stage_id for stage_id in expected_stale if statuses[stage_id]["status"] == "stale"} == expected_stale

    rows = {row["id"]: row for row in parse_procedure_stage_rows(change_path.read_text(encoding="utf-8"))}
    assert {stage_id for stage_id in expected_stale if rows[stage_id]["status"] == "stale"} == expected_stale
    with pytest.raises(ValueError, match="ddd-design-integration"):
        assert_canonical_stage_gate(tmp_path, change_set_id, "technical-decisions")
