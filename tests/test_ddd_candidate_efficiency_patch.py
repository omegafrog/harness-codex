import hashlib
from pathlib import Path
from types import SimpleNamespace

import harness_codex.runtime.ddd_candidate_efficiency_patch as candidate_patch
from harness_codex.runtime.ddd_candidate_efficiency_patch import (
    _targets_for_uc,
    _validate_candidate_write_scope,
    _validate_complete_candidate,
    _validate_visualization_contract,
)


def test_targets_for_uc_groups_all_unfinished_sections_in_one_candidate() -> None:
    ui = SimpleNamespace(
        DDD_STEPS=(
            ("entity_vo", "Entity / Value Objects"),
            ("behaviors", "Behaviors"),
            ("application_flow", "Application Flow"),
            ("aggregates", "Aggregates"),
            ("bounded_contexts", "Bounded Contexts"),
        )
    )
    state = {
        "items": {
            "UC-031": {
                "steps": {
                    "entity_vo": {"status": "complete"},
                    "behaviors": {"status": "pending"},
                    "application_flow": {"status": "error"},
                    "aggregates": {"status": "stale"},
                    "bounded_contexts": {"status": "pending"},
                }
            }
        }
    }

    assert _targets_for_uc(ui, state, "UC-031") == [
        {"uc_id": "UC-031", "step_id": "behaviors", "label": "Behaviors"},
        {"uc_id": "UC-031", "step_id": "application_flow", "label": "Application Flow"},
        {"uc_id": "UC-031", "step_id": "aggregates", "label": "Aggregates"},
        {"uc_id": "UC-031", "step_id": "bounded_contexts", "label": "Bounded Contexts"},
    ]


def _candidate(change_set_id: str, uc_id: str, event_hash: str) -> str:
    return f"""---
status: candidate
change_set: {change_set_id}
work_item: {uc_id}
input_hashes:
  event_storming: sha256:{event_hash}
---
# {uc_id}. DDD Candidate Design

## Impact Assessment
|Element Type|Element|Status|Baseline Evidence|Event Storming Evidence|
|---|---|---|---|---|
|Entity|Workspace|new|none|WorkspaceCreated|

## Entity / Value Objects
|Entity|Attributes / VOs|Status|Previous Definition|Proposed Definition|Evidence|
|---|---|---|---|---|---|
|Workspace|workspaceId: WorkspaceId|new|none|Workspace aggregate|WorkspaceCreated|

## Behaviors
|Owner / Service|Signature|Participants|Placement|Policy Evidence|
|---|---|---|---|---|
|Workspace|create(WorkspaceId)|Workspace|Aggregate|WorkspaceCreated|

## Application Flow
|Application Service|Signature|Description|Calls|Evidence|
|---|---|---|---|---|
|CreateWorkspace|create(WorkspaceId)|Creates workspace|Workspace.create|WorkspaceCreated|

## Aggregates
|Aggregate|Aggregate Root|Members|Atomic Invariant|Evidence|
|---|---|---|---|---|
|Workspace|Workspace|WorkspaceId|workspace id is unique|WorkspaceCreated|

## Bounded Contexts
|Bounded Context|Owned Aggregates / Entities|Boundary Reason|Communication Type|Target BC|Evidence|
|---|---|---|---|---|---|
|Workspace|Workspace|workspace lifecycle|None|None|WorkspaceCreated|

## Integration Impact
- Shared Aggregate / Entity claims to reconcile: none
- Candidate-only assumptions / unresolved conflicts: none

## Architecture Visualization
<!-- harness:ddd-visualization:entity_vo:start -->
```mermaid
classDiagram
    class Workspace {{
        <<entity>>
        +WorkspaceId workspaceId
    }}
```
<!-- harness:ddd-visualization:entity_vo:end -->
"""


def test_complete_candidate_requires_current_input_hash_and_managed_graph(tmp_path: Path) -> None:
    change_set_id = "CHG-20260707-1"
    uc_id = "UC-001"
    event_path = tmp_path / "docs" / "use-cases" / uc_id / "event-storming.md"
    event_path.parent.mkdir(parents=True)
    event_path.write_text("# event storming\n", encoding="utf-8")
    event_hash = hashlib.sha256(event_path.read_bytes()).hexdigest()
    candidate_path = event_path.with_name("ddd-design.md")
    candidate_path.write_text(_candidate(change_set_id, uc_id, event_hash), encoding="utf-8")

    assert _validate_complete_candidate(tmp_path, change_set_id, uc_id) == ""
    assert (tmp_path / ".harness" / "contracts" / change_set_id / uc_id / "ddd_design.contract.json").is_file()


def test_complete_candidate_rejects_stale_event_hash(tmp_path: Path) -> None:
    change_set_id = "CHG-20260707-1"
    uc_id = "UC-001"
    event_path = tmp_path / "docs" / "use-cases" / uc_id / "event-storming.md"
    event_path.parent.mkdir(parents=True)
    event_path.write_text("# event storming\n", encoding="utf-8")
    candidate_path = event_path.with_name("ddd-design.md")
    candidate_path.write_text(_candidate(change_set_id, uc_id, "0" * 64), encoding="utf-8")

    assert "event_storming input hash" in _validate_complete_candidate(tmp_path, change_set_id, uc_id)


def test_visualization_contract_rejects_multiple_mermaid_graphs(tmp_path: Path) -> None:
    path = tmp_path / "ddd-design.md"
    path.write_text(
        """## Architecture Visualization
<!-- harness:ddd-visualization:entity_vo:start -->
```mermaid
classDiagram
```
```mermaid
classDiagram
```
<!-- harness:ddd-visualization:entity_vo:end -->
""",
        encoding="utf-8",
    )

    ready, error = _validate_visualization_contract(path)
    assert not ready
    assert "exactly one Mermaid" in error


def test_candidate_scope_rejects_actual_write_outside_output(monkeypatch, tmp_path: Path) -> None:
    snapshots = iter(
        [
            {"docs/use-cases/UC-001/ddd-design.md": "file:before"},
            {
                "docs/use-cases/UC-001/ddd-design.md": "file:after",
                "ARCHITECTURE.md": "file:changed",
            },
        ]
    )
    monkeypatch.setattr(candidate_patch, "_git_snapshot", lambda _root: next(snapshots))

    error = _validate_candidate_write_scope(
        tmp_path,
        "CHG-20260707-1",
        "UC-001",
        {"docs/use-cases/UC-001/ddd-design.md": "file:before"},
    )

    assert "ARCHITECTURE.md" in error
    receipt = tmp_path / ".harness" / "contracts" / "CHG-20260707-1" / "UC-001" / "ddd-candidate-scope.json"
    assert receipt.is_file()
