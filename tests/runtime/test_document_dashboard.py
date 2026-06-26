from __future__ import annotations

import json
import subprocess
import threading
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest

from harness_codex.runtime import document_dashboard, ui_server
from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.dashboard import DashboardRun, DashboardWorkItem
from harness_codex.runtime.document_dashboard import (
    DashboardChangeSetNotFound,
    DashboardDocumentConflict,
    DashboardDocumentNotFound,
    DashboardDocumentValidationError,
    document_dashboard_state,
    delete_active_changeset,
    read_dashboard_document,
    save_dashboard_document,
)
from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.procedure_stages import render_initial_changeset
from harness_codex.runtime.state import (
    ArtifactDirtyState,
    RunState,
    RunStateStore,
    StageArtifactState,
)
from harness_codex.runtime.ui_server import HarvestUiRequestHandler


REQUIREMENTS_MARKDOWN = """# Requirements Specification

## 1. Overview
- Goal: Save one note.

## 3. Functional Requirements
- FR-001. Save one note.
"""

USE_CASE_MARKDOWN = """# UC-001. Local Note Author saves one Fleeting Note

## Actor
- Local Note Author

## Goal
- Save one note.

## Main Flow
1. Save note.

## Result
- Note is saved.
"""

GENERATED_USE_CASE_MARKDOWN = """# UC-001. Local Note Author saves one Fleeting Note

## 1. Overview
- Actor: Local Note Author
- Goal: Save one note.

## 2. Preconditions
- The UI is open.

## 3. Basic Flow
1. Save note.

## 5. Outcomes
- Note is saved.
"""

EVENT_STORMING_MARKDOWN = """# UC-001 Event Storming

## Flow
### [Flow: Main Flow]
🟦 Save `Fleeting Note`
→ 🟧 `Fleeting Note` was saved
→ 🟪 Show saved note

---
### [Flow: Exception Flow]
🟦 Save Fleeting Note
→ 🟧 Save failed

## 5. Domain Elements
|Type|Content|Trigger|Result|System|Notes|
|---|---|---|---|---|---|
|🟦|Save Fleeting Note|Author|Saved|`Note System`|-|
|🟧|`Persisted Note`|Save Fleeting Note|Show saved note|`Note System`|-|
|🟪|`Display Saved Note`|Fleeting Note was saved|none|`Note System`|-|

## 6. External Systems
|시스템|연동 목적|
|---|---|
|`Browser Store`|Persist draft|
"""

DDD_DESIGN_MARKDOWN = """# UC-001. DDD Design

## Impact Assessment
|Element Type|Element|Status|Baseline Evidence|Event Storming Evidence|
|---|---|---|---|---|
|Aggregate|Note|new|No existing design|Save Fleeting Note command|

## Entity / Value Objects
|Entity|Attributes / VOs|Status|Previous Definition|Proposed Definition|Evidence|
|---|---|---|---|---|---|
|Note|id: NoteId (required, Save Fleeting Note); content: Content (required, Save Fleeting Note); Content { text: String } (non-empty)|new|-|id: NoteId; content: Content; Content { text: String }|Save Fleeting Note command|
|Draft|title: Title (required, Persisted Note); Title { text: String } (non-empty)|Modify|~~oldTitle: OldTitle~~|title: Title; Title { text: String }|Persisted Note event|

## Behaviors
|Owner / Service|Signature|Participants|Placement|Policy Evidence|
|---|---|---|---|---|
|Note|save(NoteId id, Content content)|Note|entity method|Display Saved Note policy|

## Application Flow
|Application Service|Signature|Description|Calls|Evidence|
|---|---|---|---|---|
|SaveNoteApplicationService|save(NoteId id, Content content)|Load the note, call the aggregate save behavior, persist the changed note, and return save result data.|Note.save(id, content)|Save Fleeting Note command|

## Aggregates
|Aggregate|Aggregate Root|Members|Atomic Invariant|Evidence|
|---|---|---|---|---|
|Note|Note|Note, NoteId, Content|Save note atomically|Persisted Note event|

## Bounded Contexts
|Bounded Context|Owned Aggregates / Entities|Boundary Reason|Communication Type|Target BC|Evidence|
|---|---|---|---|---|---|
|Notes|Note|Owns note lifecycle|internal_http|Search|Display Saved Note policy|
"""

TECHNICAL_DECISIONS_MARKDOWN = """# Technical Decisions

## 1. Metadata
|Item|Value|
|---|---|
|Approval Status|approved|

## 2. Input Documents
- docs/use-cases/UC-001/ddd-design.md

## 3. Decisions
- Use synchronous persistence.

## 4. Pending Decisions
- None.
"""


def _write_change_set(root: Path, lifecycle: str = "active", *, with_use_case: bool = True) -> Path:
    path = root / "docs/changes" / lifecycle / "CHG-001.md"
    path.parent.mkdir(parents=True)
    content = render_initial_changeset(
        change_set_id="CHG-001",
        title="Save Fleeting Note",
        request_summary="Create note flow.",
    )
    if with_use_case:
        content += """\

## 5. Affected Use Cases

|UC ID|Use Case Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|
|`UC-001`|Save Fleeting Note|add|`docs/use-cases/UC-001`|ready|
"""
    path.write_text(content, encoding="utf-8")
    return path


def _write_documents(root: Path) -> None:
    for path, content in (
        (root / "docs/design/요구사항.md", REQUIREMENTS_MARKDOWN),
        (root / "docs/use-cases/UC-001/use-case.md", USE_CASE_MARKDOWN),
        (root / "docs/use-cases/UC-001/event-storming.md", EVENT_STORMING_MARKDOWN),
        (root / "docs/plans/completed/UC-001/plan.md", "# Plan\n"),
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def _write_completed_ui_workflow(root: Path) -> None:
    path = root / ".harness/ui/change-sets/CHG-001/harvest-session.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "requirements_gate_passed": True,
                "language_gate_passed": True,
                "use_cases_ready": True,
            }
        ),
        encoding="utf-8",
    )
    canonical = root / ".harness/ui/change-sets/CHG-001/docs/design/유스케이스.md"
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_text("# Use Case Document\n\n- UC-001. Save Fleeting Note\n", encoding="utf-8")
    use_case = root / ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/use-case.md"
    use_case.parent.mkdir(parents=True, exist_ok=True)
    use_case.write_text(USE_CASE_MARKDOWN, encoding="utf-8")


def test_dashboard_does_not_mark_language_complete_from_requirements_only(
    tmp_path: Path,
) -> None:
    _write_change_set(tmp_path)
    session_path = tmp_path / ".harness/ui/change-sets/CHG-001/harvest-session.json"
    session_path.parent.mkdir(parents=True, exist_ok=True)
    session_path.write_text(
        json.dumps(
            {
                "requirements_gate_passed": True,
                "language_gate_passed": False,
                "use_cases_ready": False,
            }
        ),
        encoding="utf-8",
    )

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    stages = {stage["id"]: stage for stage in change_set["stages"]}

    assert stages["ubiquitous-language-definition"]["status"] == "pending"
    assert stages["ubiquitous-language-definition"].get("source") != "dashboard_workflow"
    assert stages["use-case-definition"]["status"] == "pending"


def _write_completed_event_storming_workflow(root: Path) -> None:
    _write_completed_ui_workflow(root)
    session_path = root / ".harness/ui/change-sets/CHG-001/harvest-session.json"
    session = json.loads(session_path.read_text(encoding="utf-8"))
    session["event_storming"] = {
        "uc_ids": ["UC-001"],
        "items": {"UC-001": {"status": "complete"}},
        "current_uc": "UC-001",
        "completed_count": 1,
        "complete": True,
        "status": "complete",
    }
    session_path.write_text(json.dumps(session), encoding="utf-8")
    path = root / ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/event-storming.md"
    path.write_text(EVENT_STORMING_MARKDOWN, encoding="utf-8")


def _write_completed_ddd_architecture_workflow(root: Path) -> None:
    _write_completed_event_storming_workflow(root)
    session_path = root / ".harness/ui/change-sets/CHG-001/harvest-session.json"
    session = json.loads(session_path.read_text(encoding="utf-8"))
    step_ids = ["entity_vo", "behaviors", "application_flow", "aggregates", "bounded_contexts"]
    session["ddd_architecture"] = {
        "uc_ids": ["UC-001"],
        "items": {
            "UC-001": {
                "status": "complete",
                "steps": {step_id: {"status": "complete", "clarifications": []} for step_id in step_ids},
            }
        },
        "current_uc": None,
        "current_step": "bounded_contexts",
        "completed_count": len(step_ids),
        "complete": True,
        "status": "complete",
    }
    session_path.write_text(json.dumps(session), encoding="utf-8")
    path = root / ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/ddd-design.md"
    path.write_text(DDD_DESIGN_MARKDOWN, encoding="utf-8")


def test_document_dashboard_projects_docs_board_and_folder_lifecycle(tmp_path: Path) -> None:
    _write_change_set(tmp_path, "completed")
    _write_documents(tmp_path)

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]

    assert change_set["lifecycle"] == "completed"
    assert change_set["documents"] == [
        {
            "id": "change-set:CHG-001",
            "kind": "change-set",
            "label": "ChangeSet (Read only)",
            "path": "docs/changes/completed/CHG-001.md",
            "editable": False,
        }
    ]
    assert change_set["stages"][0]["id"] == "requirements-definition"
    assert change_set["stages"][1]["id"] == "ubiquitous-language-definition"
    work_item = change_set["work_items"][0]
    assert "docs/plans/completed/UC-001/plan.md" in {
        artifact["path"] for artifact in work_item["artifacts"]
    }
    flows = work_item["event_storming"]["flows"]
    assert [flow["kind"] for flow in flows] == ["main", "exception"]
    assert flows[0]["notes"][0] == {"type": "command", "text": "Save Fleeting Note"}
    assert flows[0]["notes"][1] == {"type": "event", "text": "Persisted Note"}


def test_document_dashboard_projects_current_documents_without_changeset_ownership(
    tmp_path: Path,
) -> None:
    _write_documents(tmp_path)
    ddd_path = tmp_path / "docs/use-cases/UC-001/ddd-design.md"
    ddd_path.write_text(DDD_DESIGN_MARKDOWN, encoding="utf-8")

    state = document_dashboard_state(tmp_path)

    assert state["change_sets"] == []
    project = state["project_documents"]
    lanes = {lane["id"]: lane for lane in project["lanes"]}
    assert [document["kind"] for document in lanes["UC-001"]["documents"]] == [
        "use-case",
        "event-storming",
        "ddd-design",
        "plan",
    ]
    document = lanes["UC-001"]["documents"][0]
    loaded = read_dashboard_document(tmp_path, document["id"])
    assert loaded["path"] == "docs/use-cases/UC-001/use-case.md"
    assert loaded["editable"] is False


def test_project_document_reader_rejects_unprojected_markdown(tmp_path: Path) -> None:
    hidden = tmp_path / "docs/private.md"
    hidden.parent.mkdir(parents=True)
    hidden.write_text("# Hidden\n", encoding="utf-8")

    with pytest.raises(DashboardDocumentNotFound):
        read_dashboard_document(tmp_path, "project-document:docs/private.md")


def test_project_document_map_includes_maintenance_slice_and_plan(tmp_path: Path) -> None:
    maintenance = tmp_path / "docs/maintenance/MAINT-001"
    maintenance.mkdir(parents=True)
    for filename in ("change-intent.md", "affected-files.md", "verification-goal.md"):
        (maintenance / filename).write_text(f"# {filename}\n", encoding="utf-8")
    plan = tmp_path / "docs/plans/active/MAINT-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("# Maintenance Plan\n", encoding="utf-8")

    lane = document_dashboard_state(tmp_path)["project_documents"]["lanes"][0]

    assert lane["id"] == "MAINT-001"
    assert [document["kind"] for document in lane["documents"]] == [
        "change-intent",
        "affected-files",
        "verification-goal",
        "plan",
    ]


def test_document_dashboard_appends_missing_change_set_pr_stage_for_legacy_change_sets(
    tmp_path: Path,
) -> None:
    change_dir = tmp_path / "docs/changes/completed"
    change_dir.mkdir(parents=True)
    (change_dir / "CHG-001.md").write_text(
        """# Legacy ChangeSet

## 1. Metadata

|Item|Value|
|---|---|
|ChangeSet ID|`CHG-001`|
|Status|completed|

## 3. Runtime Procedure State

|Stage ID|Procedure|Status|Verified At|Notes|
|---|---|---|---|---|
|implementation|Implementation|verified|2026-01-01T00:00:00Z|-|
""",
        encoding="utf-8",
    )

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    stages = {stage["id"]: stage for stage in change_set["stages"]}

    assert stages["change-set-pr"]["procedure"] == "ChangeSet PR"
    assert stages["change-set-pr"]["status"] == "pending"


def test_document_dashboard_attaches_latest_runtime_summary_and_history(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    item = DashboardWorkItem(
        work_item_id="UC-001",
        work_item_type=WorkItemType.USE_CASE,
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
        current_stage="implementation",
        status=RunStatus.RUNNING,
    )
    runs = (
        DashboardRun("run-old", "CHG-001", RunStatus.FAILED, (item,), Path("old.md")),
        DashboardRun("run-new", "CHG-001", RunStatus.RUNNING, (item,), Path("new.md")),
    )
    monkeypatch.setattr(document_dashboard, "load_dashboard_runs", lambda _root: runs)
    monkeypatch.setattr(
        document_dashboard,
        "_run_recency",
        lambda _root, run: (2 if run.run_id == "run-new" else 1, run.run_id),
    )

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]

    assert change_set["latest_run"]["run_id"] == "run-new"
    assert [run["run_id"] for run in change_set["run_history"]] == ["run-new", "run-old"]


def test_document_dashboard_exposes_technical_decisions_for_active_use_case(
    tmp_path: Path,
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    path = tmp_path / "docs/use-cases/UC-001/technical-decisions.md"
    path.write_text(TECHNICAL_DECISIONS_MARKDOWN, encoding="utf-8")

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    document = next(
        item for item in change_set["documents"] if item["kind"] == "technical-decisions"
    )

    assert document["id"] == "technical-decisions:CHG-001:UC-001"
    loaded = read_dashboard_document(tmp_path, document["id"])
    assert loaded["content"] == TECHNICAL_DECISIONS_MARKDOWN
    assert loaded["editable"] is True


def test_document_dashboard_ignores_changeset_sibling_artifacts(tmp_path: Path) -> None:
    _write_change_set(tmp_path)
    artifact = tmp_path / "docs/changes/active/CHG-001.ddd-integration.md"
    artifact.write_text(
        "---\nchange_set_id: CHG-001\n---\n# Integration\n",
        encoding="utf-8",
    )

    state = document_dashboard_state(tmp_path)

    assert [item["id"] for item in state["change_sets"]] == ["CHG-001"]


def test_document_dashboard_falls_back_to_integration_candidates_for_work_items(
    tmp_path: Path,
) -> None:
    _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    contract = tmp_path / "docs/changes/active/CHG-001.ddd-integration.json"
    contract.write_text(
        json.dumps(
            {
                "candidate_inputs": [
                    {
                        "uc_id": "UC-001",
                        "path": "docs/use-cases/UC-001/ddd-design.md",
                        "hash": "sha256:test",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    planning = ui_server.planning_progress_state(tmp_path, "CHG-001")

    assert [item["id"] for item in change_set["work_items"]] == ["UC-001"]
    assert planning["plans"][0]["work_item_id"] == "UC-001"


def test_document_dashboard_projects_plan_checklist_progress(tmp_path: Path) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(
        "# Plan\n\n- [x] Build implementation endpoint\n- [ ] Add dashboard diff explorer\n",
        encoding="utf-8",
    )

    work_item = document_dashboard_state(tmp_path)["change_sets"][0]["work_items"][0]

    assert work_item["plan"]["path"] == "docs/plans/active/UC-001/plan.md"
    assert work_item["plan"]["completed_count"] == 1
    assert work_item["plan"]["total_count"] == 2
    assert work_item["plan"]["percent"] == 50
    assert work_item["plan"]["tasks"][1] == {
        "line": 4,
        "checked": False,
        "text": "Add dashboard diff explorer",
    }


def test_implementation_progress_state_exposes_git_diff_files(tmp_path: Path) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=tmp_path, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=tmp_path, check=True)
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    tracked = tmp_path / "tracked file.txt"
    tracked.write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=tmp_path, check=True, capture_output=True, text=True)
    tracked.write_text("after\n", encoding="utf-8")

    state = ui_server.implementation_progress_state(tmp_path, "CHG-001")
    diff = ui_server.implementation_diff_file(tmp_path, "CHG-001", "tracked file.txt")

    assert state["plans"][0]["work_item_id"] == "UC-001"
    assert state["diff"]["files"] == [{"path": "tracked file.txt", "status": "M"}]
    assert "-before" in diff["patch"]
    assert "+after" in diff["patch"]
    assert diff["stale"] is False

    subprocess.run(["git", "checkout", "--", "tracked file.txt"], cwd=tmp_path, check=True)
    stale = ui_server.implementation_diff_file(tmp_path, "CHG-001", "tracked file.txt")

    assert stale == {
        "path": "tracked file.txt",
        "patch": "",
        "truncated": False,
        "stale": True,
        "files": [],
    }


def test_planning_progress_state_exposes_work_item_plans(tmp_path: Path) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("# Plan\n\n- [ ] Implement note saving\n", encoding="utf-8")

    state = ui_server.planning_progress_state(tmp_path, "CHG-001")

    assert state["plans"][0]["work_item_id"] == "UC-001"
    assert state["plans"][0]["path"] == "docs/plans/active/UC-001/plan.md"


def test_plan_writing_job_runs_selected_use_case(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ui_server._PLAN_WRITING_JOBS["CHG-001"] = {"status": "running"}
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["command"] = command
        captured["cwd"] = kwargs["cwd"]
        return subprocess.CompletedProcess(command, 0, stdout="planned", stderr="")

    monkeypatch.setattr(ui_server.subprocess, "run", fake_run)

    ui_server._run_plan_writing_job(tmp_path, "CHG-001", "UC-001")

    assert captured["command"][-4:] == ["plan-writing", "CHG-001", "--uc", "UC-001"]
    assert captured["cwd"] == tmp_path
    assert ui_server._PLAN_WRITING_JOBS["CHG-001"]["status"] == "succeeded"


def test_dashboard_script_orders_plan_writing_implementation_and_delivery() -> None:
    script = (
        Path(__file__).parents[2]
        / "harness_codex/runtime/dashboard_assets/dashboard.js"
    ).read_text(encoding="utf-8")

    assert script.index('data-stage-tab="planning"') < script.index('data-stage-tab="implementation"')
    assert script.index('data-stage-tab="implementation"') < script.index('data-stage-tab="delivery"')
    assert "data-stage-tab=\"planning\"" in script
    assert "data-stage-tab=\"delivery\"" in script
    assert "harness plan-writing" in script
    assert "harness-change-set-pr" in script
    assert "app.implementationSelectedDiffPath = \"\";" in script


def test_dashboard_script_restores_stage_rerun_progress_on_panel_open() -> None:
    script = (
        Path(__file__).parents[2]
        / "harness_codex/runtime/dashboard_assets/dashboard.js"
    ).read_text(encoding="utf-8")

    assert "await loadStageRerunProgress(change);" in script
    assert "async function loadStageRerunProgress(change)" in script
    assert "app.rerunStageId = result.job.stage_id || app.rerunStageId;" in script


def test_dashboard_script_restores_stage_rerun_progress_on_resume_workflow() -> None:
    script = (
        Path(__file__).parents[2]
        / "harness_codex/runtime/dashboard_assets/dashboard.js"
    ).read_text(encoding="utf-8")

    assert "await loadStageRerunProgress({ id: changeSetId });" in script
    assert "app.stageTab = workflowTabForRerunJob(app.rerunJob) || app.stageTab;" in script
    assert 'if (job.stage_id === "technical-decisions") return "technicalDecisions";' in script
    assert "app.technicalSelectedUc = app.rerunJob?.uc_id || app.technicalSelectedUc;" in script


def test_dashboard_projects_completed_ui_workflow_and_generated_use_cases_document(tmp_path: Path) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    _write_completed_ui_workflow(tmp_path)

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    statuses = {stage["id"]: stage["status"] for stage in change_set["stages"]}
    documents = {document["id"]: document for document in change_set["documents"]}

    assert statuses["requirements-definition"] == "verified"
    assert statuses["ubiquitous-language-definition"] == "verified"
    assert statuses["use-case-definition"] == "verified"
    assert documents["generated-use-cases:CHG-001"]["label"] == "Use Cases (Read only)"
    loaded = read_dashboard_document(tmp_path, "generated-use-cases:CHG-001")
    assert loaded["editable"] is False
    assert loaded["path"] == ".harness/ui/change-sets/CHG-001/docs/design/유스케이스.md"
    assert "UC-001. Save Fleeting Note" in loaded["content"]


def test_dashboard_does_not_let_ui_workflow_overwrite_explicit_stage_blockers(
    tmp_path: Path,
) -> None:
    change_path = _write_change_set(tmp_path)
    text = change_path.read_text(encoding="utf-8")
    text = text.replace(
        "|event-storming|Event Storming|pending|-|-|",
        "|event-storming|Event Storming|stale|2026-06-13T04:36:14Z|stale after forced rerun|",
    )
    text = text.replace(
        "|ddd-architecture-definition|DDD Architecture Definition|pending|-|-|",
        "|ddd-architecture-definition|DDD Architecture Definition|stale|2026-06-13T04:36:14Z|stale after forced rerun|",
    )
    text = text.replace(
        "|technical-decisions|Technical Decisions|pending|-|-|",
        "|technical-decisions|Technical Decisions|blocked|2026-06-15T04:00:05Z|upstream gate unresolved|",
    )
    change_path.write_text(text, encoding="utf-8")
    _write_documents(tmp_path)
    _write_completed_ddd_architecture_workflow(tmp_path)

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    stages = {stage["id"]: stage for stage in change_set["stages"]}

    assert stages["event-storming"]["status"] == "stale"
    assert stages["event-storming"]["source"] == "changeset"
    assert stages["ddd-architecture-definition"]["status"] == "stale"
    assert stages["ddd-architecture-definition"]["source"] == "changeset"
    assert stages["technical-decisions"]["status"] == "blocked"
    assert stages["technical-decisions"].get("source") != "dashboard_workflow"


def test_dashboard_stage_projection_prefers_run_state_over_ui_workflow_state(
    tmp_path: Path,
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    _write_completed_ui_workflow(tmp_path)
    RunStateStore(tmp_path).save(
        RunState(
            run_id="run-001",
            change_set_id="CHG-001",
            workflow_name="workflow",
            mode=RunMode.APPLY,
            affected_use_cases=("UC-001",),
            artifact_states=(
                StageArtifactState(
                    stage="requirements-definition",
                    path=Path("docs/design/요구사항.md"),
                    accepted=False,
                    downstream_status=ArtifactDirtyState.NEEDS_REAPPLY,
                ),
            ),
        )
    )

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    stages = {stage["id"]: stage for stage in change_set["stages"]}

    assert stages["requirements-definition"]["status"] == "pending"
    assert stages["requirements-definition"]["source"] == "run_state"
    assert "downstream=needs_reapply" in stages["requirements-definition"]["notes"]


def test_dashboard_exposes_editable_scoped_generated_use_case_slice(tmp_path: Path) -> None:
    change_path = _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_ui_workflow(tmp_path)

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    documents = {document["id"]: document for document in change_set["documents"]}
    document_id = "generated-use-case:CHG-001:UC-001"

    assert documents[document_id]["editable"] is True
    assert documents[document_id]["path"] == (
        ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/use-case.md"
    )
    loaded = read_dashboard_document(tmp_path, document_id)
    saved = save_dashboard_document(
        tmp_path,
        document_id,
        content=loaded["content"].replace("Save one note.", "Save edited note."),
        revision=loaded["revision"],
    )

    assert "Save edited note." in saved["content"]
    assert saved["metadata"]["doc_type"] == "use_case"
    assert saved["metadata"]["change_set_id"] == "CHG-001"
    assert saved["metadata"]["work_item_id"] == "UC-001"
    assert "|event-storming|Event Storming|stale|" in change_path.read_text(encoding="utf-8")


def test_dashboard_exposes_completed_event_storming_document_and_aggregate_board(tmp_path: Path) -> None:
    change_path = _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_event_storming_workflow(tmp_path)

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    statuses = {stage["id"]: stage["status"] for stage in change_set["stages"]}
    document_id = "event-storming:CHG-001:UC-001"

    assert statuses["event-storming"] == "verified"
    assert document_id in {item["id"] for item in change_set["documents"]}
    assert change_set["event_storming_board"]["slices"][0]["uc_id"] == "UC-001"
    assert change_set["event_storming_board"]["slices"][0]["flows"][0]["notes"][:2] == [
        {"type": "command", "text": "Save Fleeting Note"},
        {"type": "event", "text": "Persisted Note"},
    ]
    assert change_set["event_storming_board"]["slices"][0]["flows"][0]["notes"][2] == {
        "type": "policy",
        "text": "Display Saved Note",
    }
    assert {"type": "system", "text": "Note System"} in change_set["event_storming_board"]["slices"][0][
        "supporting_notes"
    ]
    assert {"type": "external_system", "text": "Browser Store"} in change_set["event_storming_board"]["slices"][0][
        "supporting_notes"
    ]
    loaded = read_dashboard_document(tmp_path, document_id)
    saved = save_dashboard_document(
        tmp_path,
        document_id,
        content=loaded["content"].replace("`Persisted Note`", "`Stored Note`"),
        revision=loaded["revision"],
    )
    assert "Stored Note" in saved["content"]
    refreshed = document_dashboard_state(tmp_path)["change_sets"][0]
    assert refreshed["event_storming_board"]["slices"][0]["flows"][0]["notes"][1] == {
        "type": "event",
        "text": "Stored Note",
    }
    assert "|ddd-architecture-definition|DDD Architecture Definition|stale|" in change_path.read_text(
        encoding="utf-8"
    )


def test_event_storming_basic_flow_renders_as_main_flow(tmp_path: Path) -> None:
    _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_event_storming_workflow(tmp_path)
    path = tmp_path / ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/event-storming.md"
    path.write_text(
        EVENT_STORMING_MARKDOWN.replace("[Flow: Main Flow]", "[Flow: Basic flow]"),
        encoding="utf-8",
    )

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    flows = change_set["event_storming_board"]["slices"][0]["flows"]

    assert flows[0]["name"] == "Main Flow"
    assert flows[0]["kind"] == "main"
    assert flows[1]["name"] == "Exception Flow 1"


def test_dashboard_exposes_completed_ddd_document_and_visual_board(tmp_path: Path) -> None:
    _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_ddd_architecture_workflow(tmp_path)

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    statuses = {stage["id"]: stage["status"] for stage in change_set["stages"]}
    documents = {document["id"]: document for document in change_set["documents"]}
    board = change_set["ddd_architecture_board"]

    assert statuses["ddd-architecture-definition"] == "verified"
    assert documents["ddd-design:CHG-001:UC-001"]["editable"] is True
    assert documents["ddd-design:CHG-001:UC-001"]["path"] == (
        ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/ddd-design.md"
    )
    assert board["slices"][0]["uc_id"] == "UC-001"
    assert board["slices"][0]["completed_steps"] == [
        "entity_vo",
        "behaviors",
        "application_flow",
        "aggregates",
        "bounded_contexts",
    ]
    assert board["slices"][0]["entity_vo"][0]["Entity"] == "Note"
    assert board["slices"][0]["behaviors"][0]["Signature"] == "save(NoteId id, Content content)"
    assert board["slices"][0]["application_flow"][0]["Application Service"] == "SaveNoteApplicationService"
    assert board["slices"][0]["aggregates"][0]["Aggregate Root"] == "Note"
    assert board["slices"][0]["bounded_contexts"][0]["Communication Type"] == "internal_http"


def test_dashboard_normalizes_generated_entity_vo_table_variant(tmp_path: Path) -> None:
    _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_ddd_architecture_workflow(tmp_path)
    path = tmp_path / ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/ddd-design.md"
    path.write_text(
        """# UC-001. DDD Design

## Impact Assessment
| Area | Decision | Impact | Evidence |
| --- | --- | --- | --- |
| Workspace-backed explorer domain | `new` | New model. | Open selected Markdown Note |

## Entity / Value Objects
| Model | Kind | Proposed Identity / State | Why new |
| --- | --- | --- | --- |
| `MarkdownNote` | Entity | `WorkspaceRelativePath path`, openable file content loaded from that path | Path identity matters. |
| | | | |
| `WorkspaceRelativePath` | Value Object | Normalized relative path constrained beneath `NoteWorkspace` | Prevents escaping root. |

### Evidence
- Open selected Markdown Note.
""",
        encoding="utf-8",
    )

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    row = change_set["ddd_architecture_board"]["slices"][0]["entity_vo"][0]

    assert len(change_set["ddd_architecture_board"]["slices"][0]["entity_vo"]) == 2
    assert row["Entity"] == "MarkdownNote"
    assert row["Model Type"] == "Entity"
    assert row["Attributes / VOs"] == "WorkspaceRelativePath path, openable file content loaded from that path"


def test_dashboard_derives_entity_vo_model_type_from_impact_assessment(tmp_path: Path) -> None:
    _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_ddd_architecture_workflow(tmp_path)
    path = tmp_path / ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/ddd-design.md"
    path.write_text(
        """# UC-001. DDD Design

## Impact Assessment
| Element Type | Element | Status | Baseline Evidence | Event Storming Evidence |
| --- | --- | --- | --- | --- |
| Value Object | `NoteWorkspace` | new | No existing design | Workspace is fixed |
| Entity | `MarkdownNote` | new | No existing design | Open selected Markdown Note |

## Entity / Value Objects
| Entity | Attributes / VOs | Status | Previous Definition | Proposed Definition | Evidence |
| --- | --- | --- | --- | --- | --- |
| `NoteWorkspace` | `rootPath: WorkspaceRelativePath` | new | - | Boundary value object. | Workspace is fixed |
| `MarkdownNote` | `notePath: WorkspaceRelativePath` | new | - | File-backed note entity. | Open selected Markdown Note |
""",
        encoding="utf-8",
    )

    rows = document_dashboard_state(tmp_path)["change_sets"][0]["ddd_architecture_board"]["slices"][0]["entity_vo"]

    assert rows[0]["Model Type"] == "Value Object"
    assert rows[1]["Model Type"] == "Entity"


def test_dashboard_derives_typed_properties_and_vo_references_from_ddd_document(tmp_path: Path) -> None:
    _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_ddd_architecture_workflow(tmp_path)
    path = tmp_path / ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/ddd-design.md"
    path.write_text(
        """# UC-001. DDD Design

## Impact Assessment
| Element Type | Element | Status | Baseline Evidence | Event Storming Evidence |
| --- | --- | --- | --- | --- |
| Entity | `Purchase` | new | No existing design | Place Purchase command |
| Value Object | `Money` | new | No existing design | Purchase total must be normalized |

## Entity / Value Objects
| Entity | Attributes / VOs | Status | Previous Definition | Proposed Definition | Evidence |
| --- | --- | --- | --- | --- | --- |
| `Purchase` | `id: PurchaseId`; `slug: string`; `participantIds: list<ParticipantId>`; `total: Money`; `Money { amount: Decimal, currency: String }` | new | - | `id: PurchaseId`; `slug: string`; `participantIds: list<ParticipantId>`; `total: Money`; `Money { amount: Decimal, currency: String }` | Place Purchase command |
| `Money` | `amount: Decimal`; `currency: String` | new | - | `amount: Decimal`; `currency: String` | Purchase total must be normalized |
""",
        encoding="utf-8",
    )

    rows = document_dashboard_state(tmp_path)["change_sets"][0]["ddd_architecture_board"]["slices"][0]["entity_vo"]
    purchase = rows[0]
    money = rows[1]

    assert purchase["Properties"] == [
        {"name": "id", "type": "PurchaseId", "display": "PurchaseId id", "kind": "attribute"},
        {"name": "slug", "type": "string", "display": "string slug", "kind": "attribute"},
        {
            "name": "participantIds",
            "type": "list<ParticipantId>",
            "display": "list<ParticipantId> participantIds",
            "kind": "attribute",
        },
        {"name": "total", "type": "Money", "display": "Money total", "kind": "vo"},
    ]
    assert purchase["VO References"] == [
        {"name": "total", "type": "Money", "display": "Money total", "kind": "vo"},
    ]
    assert money["Properties"] == [
        {"name": "amount", "type": "Decimal", "display": "Decimal amount", "kind": "attribute"},
        {"name": "currency", "type": "String", "display": "String currency", "kind": "attribute"},
    ]


def test_saving_ddd_design_stales_later_completed_substeps(tmp_path: Path) -> None:
    change_path = _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_ddd_architecture_workflow(tmp_path)
    loaded = read_dashboard_document(tmp_path, "ddd-design:CHG-001:UC-001")

    saved = save_dashboard_document(
        tmp_path,
        "ddd-design:CHG-001:UC-001",
        content=loaded["content"].replace(
            "content: Content (required, Save Fleeting Note)",
            "content: Content (required, Save Fleeting Note); savedAt: Instant (optional, Persisted Note)",
            1,
        ),
        revision=loaded["revision"],
    )

    assert "savedAt" in saved["content"]
    session = json.loads(
        (tmp_path / ".harness/ui/change-sets/CHG-001/harvest-session.json").read_text(encoding="utf-8")
    )
    steps = session["ddd_architecture"]["items"]["UC-001"]["steps"]
    assert steps["entity_vo"]["status"] == "complete"
    assert steps["behaviors"]["status"] == "stale"
    assert steps["bounded_contexts"]["status"] == "stale"
    assert session["ddd_architecture"]["complete"] is False
    assert "|technical-decisions|Technical Decisions|stale|" in change_path.read_text(encoding="utf-8")


def test_saving_ddd_design_requires_typed_entity_value_object_attributes(tmp_path: Path) -> None:
    _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_ddd_architecture_workflow(tmp_path)
    loaded = read_dashboard_document(tmp_path, "ddd-design:CHG-001:UC-001")

    with pytest.raises(DashboardDocumentValidationError, match="typed entity or value-object attributes"):
        save_dashboard_document(
            tmp_path,
            "ddd-design:CHG-001:UC-001",
            content=loaded["content"].replace(
                "id: NoteId (required, Save Fleeting Note); content: Content (required, Save Fleeting Note); Content { text: String } (non-empty)",
                "NoteId, Content",
            ).replace(
                "title: Title (required, Persisted Note); Title { text: String } (non-empty)",
                "Title",
            ).replace(
                "id: NoteId; content: Content; Content { text: String }",
                "NoteId, Content",
            ).replace(
                "title: Title; Title { text: String }",
                "Title",
            ),
            revision=loaded["revision"],
        )


def test_saving_ddd_design_rejects_placeholder_aggregate_name(tmp_path: Path) -> None:
    _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_ddd_architecture_workflow(tmp_path)
    loaded = read_dashboard_document(tmp_path, "ddd-design:CHG-001:UC-001")

    with pytest.raises(DashboardDocumentValidationError, match="explicit aggregate names"):
        save_dashboard_document(
            tmp_path,
            "ddd-design:CHG-001:UC-001",
            content=loaded["content"].replace(
                "|Note|Note|Note, NoteId, Content|Save note atomically|Persisted Note event|",
                "|Aggregate|Note|Note, NoteId, Content|Save note atomically|Persisted Note event|",
            ),
            revision=loaded["revision"],
        )


def test_editing_generated_use_case_invalidates_scoped_event_storming_output(tmp_path: Path) -> None:
    _write_change_set(tmp_path, with_use_case=False)
    _write_documents(tmp_path)
    _write_completed_event_storming_workflow(tmp_path)
    loaded = read_dashboard_document(tmp_path, "generated-use-case:CHG-001:UC-001")

    save_dashboard_document(
        tmp_path,
        "generated-use-case:CHG-001:UC-001",
        content=loaded["content"].replace("Save one note.", "Save changed note."),
        revision=loaded["revision"],
    )

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    assert "event-storming:CHG-001:UC-001" not in {item["id"] for item in change_set["documents"]}
    assert change_set["event_storming_board"]["slices"] == []


def test_save_requirements_requires_current_revision_and_stales_downstream_stages(
    tmp_path: Path,
) -> None:
    change_path = _write_change_set(tmp_path)
    _write_documents(tmp_path)
    loaded = read_dashboard_document(tmp_path, "requirements:CHG-001")

    saved = save_dashboard_document(
        tmp_path,
        "requirements:CHG-001",
        content=REQUIREMENTS_MARKDOWN.replace("Save one note.", "Save a durable note."),
        revision=loaded["revision"],
    )

    assert "Save a durable note." in saved["content"]
    change_text = change_path.read_text(encoding="utf-8")
    assert "|requirements-definition|Requirements Definition|pending|" in change_text
    assert "|ubiquitous-language-definition|Ubiquitous Language Definition|stale|" in change_text
    assert "|use-case-definition|Use Case Definition|stale|" in change_text
    assert "|implementation|Implementation|stale|" in change_text
    assert "|change-set-pr|ChangeSet PR|stale|" in change_text
    assert (tmp_path / "docs/use-cases/UC-001/event-storming.md").exists()
    with pytest.raises(DashboardDocumentConflict):
        save_dashboard_document(
            tmp_path,
            "requirements:CHG-001",
            content=REQUIREMENTS_MARKDOWN,
            revision=loaded["revision"],
        )


def test_save_use_case_validates_structure_and_stales_only_later_stages(tmp_path: Path) -> None:
    change_path = _write_change_set(tmp_path)
    _write_documents(tmp_path)
    loaded = read_dashboard_document(tmp_path, "use-case:CHG-001:UC-001")

    with pytest.raises(DashboardDocumentValidationError):
        save_dashboard_document(
            tmp_path,
            "use-case:CHG-001:UC-001",
            content="# UC-001. Broken\n",
            revision=loaded["revision"],
        )
    save_dashboard_document(
        tmp_path,
        "use-case:CHG-001:UC-001",
        content=USE_CASE_MARKDOWN.replace("Save one note.", "Save revised note."),
        revision=loaded["revision"],
    )
    change_text = change_path.read_text(encoding="utf-8")
    assert "|use-case-definition|Use Case Definition|pending|" in change_text
    assert "|event-storming|Event Storming|stale|" in change_text
    assert "|implementation|Implementation|stale|" in change_text
    assert "|change-set-pr|ChangeSet PR|stale|" in change_text


def test_save_use_case_accepts_generated_slice_structure(tmp_path: Path) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    loaded = read_dashboard_document(tmp_path, "use-case:CHG-001:UC-001")

    saved = save_dashboard_document(
        tmp_path,
        "use-case:CHG-001:UC-001",
        content=GENERATED_USE_CASE_MARKDOWN,
        revision=loaded["revision"],
    )

    assert "## 3. Basic Flow" in saved["content"]


def test_completed_change_set_documents_are_not_editable(tmp_path: Path) -> None:
    _write_change_set(tmp_path, "completed")
    _write_documents(tmp_path)

    loaded = read_dashboard_document(tmp_path, "change-set:CHG-001")

    assert loaded["editable"] is False
    assert loaded["path"] == "docs/changes/completed/CHG-001.md"
    assert "# Save Fleeting Note" in loaded["content"]
    with pytest.raises(DashboardDocumentNotFound):
        read_dashboard_document(tmp_path, "requirements:CHG-001")
    with pytest.raises(DashboardDocumentNotFound):
        save_dashboard_document(
            tmp_path,
            "change-set:CHG-001",
            content=loaded["content"],
            revision=loaded["revision"],
        )


def test_ui_server_serves_dashboard_and_edit_api(tmp_path: Path) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)

    class Handler(HarvestUiRequestHandler):
        repo_root = tmp_path

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urlopen(f"{base}/dashboard") as response:
            assert "Document Dashboard" in response.read().decode("utf-8")
        with urlopen(f"{base}/assets/dashboard.js") as response:
            assert "loadDashboard" in response.read().decode("utf-8")
        with urlopen(f"{base}/api/dashboard") as response:
            payload = json.loads(response.read().decode("utf-8"))
        with urlopen(f"{base}/api/endpoints") as response:
            endpoints_payload = json.loads(response.read().decode("utf-8"))
        assert payload["change_sets"][0]["id"] == "CHG-001"
        assert {
            "method": "GET",
            "path": "/api/dashboard",
            "description": "dashboard document state",
        } in endpoints_payload["endpoints"]
        document_url = f"{base}/api/dashboard/documents/requirements%3ACHG-001"
        with urlopen(document_url) as response:
            loaded = json.loads(response.read().decode("utf-8"))
        request = Request(
            document_url,
            method="PUT",
            headers={"content-type": "application/json"},
            data=json.dumps(
                {
                    "content": REQUIREMENTS_MARKDOWN.replace("Save one note.", "Save edited note."),
                    "revision": loaded["revision"],
                }
            ).encode("utf-8"),
        )
        with urlopen(request) as response:
            saved = json.loads(response.read().decode("utf-8"))
        assert "Save edited note." in saved["content"]
        with urlopen(f"{base}/api/dashboard") as response:
            refreshed = json.loads(response.read().decode("utf-8"))
        statuses = {stage["id"]: stage["status"] for stage in refreshed["change_sets"][0]["stages"]}
        assert statuses["use-case-definition"] == "stale"
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def test_rerun_design_stage_forces_stage_and_returns_refreshed_dashboard(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    calls: list[tuple[list[str], Path, object, dict[str, str]]] = []

    def fake_run(command, *, cwd, text, capture_output, check, stdin, env):
        calls.append((command, cwd, stdin, env))
        assert text is True
        assert capture_output is True
        assert check is False
        assert stdin == subprocess.DEVNULL
        assert env["HARNESS_NONINTERACTIVE"] == "1"
        return subprocess.CompletedProcess(command, 0, "Verification: passed\n", "")

    monkeypatch.setattr(ui_server.subprocess, "run", fake_run)
    monkeypatch.setattr(ui_server, "activate_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(ui_server, "save_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(
        ui_server,
        "load_changeset_harvest_ui",
        lambda *_args: type("Result", (), {"as_dict": lambda self: {"status": "event_storming_ready"}})(),
    )

    payload = ui_server.rerun_design_stage(
        tmp_path,
        "CHG-001",
        "event-storming",
        "Add cancellation invariant.",
        uc_id="UC-001",
    )

    assert len(calls) == 1
    command, cwd, stdin, env = calls[0]
    assert command == [
        ui_server.sys.executable,
        "-m",
        "harness_codex",
        "--repo-root",
        str(tmp_path.resolve()),
        "event-storming",
        "CHG-001",
        "--idea",
        "Add cancellation invariant.",
        "--force",
        "--uc",
        "UC-001",
    ]
    assert cwd == Path(ui_server.__file__).resolve().parents[2]
    assert stdin == subprocess.DEVNULL
    assert env["HARNESS_NONINTERACTIVE"] == "1"
    assert payload["output"] == "Verification: passed"
    assert payload["harvest"]["status"] == "event_storming_ready"
    assert payload["dashboard"]["change_sets"][0]["id"] == "CHG-001"
    statuses = {
        stage["id"]: stage["status"]
        for stage in payload["dashboard"]["change_sets"][0]["stages"]
    }
    assert statuses["event-storming"] == "pending"
    assert statuses["ddd-architecture-definition"] == "stale"
    assert statuses["implementation"] == "stale"
    assert statuses["change-set-pr"] == "stale"


def test_rerun_design_stage_returns_pending_questions_and_passes_answers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    session_path = tmp_path / ".harness/runs/run-test/grill-me-session.json"
    calls: list[dict[str, str]] = []

    def fake_run(command, *, cwd, text, capture_output, check, stdin, env):
        calls.append(env)
        session_path.parent.mkdir(parents=True, exist_ok=True)
        session_path.write_text(
            json.dumps(
                {
                    "pending_questions": [
                        {
                            "question": "Which success condition is canonical?",
                            "recommended": "Use saved-note availability.",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(
            command,
            0,
            "\n".join(
                [
                    "Interactive status: needs_input",
                    "Verification: skipped",
                    "Session: .harness/runs/run-test/grill-me-session.json",
                ]
            ),
            "",
        )

    monkeypatch.setattr(ui_server.subprocess, "run", fake_run)
    monkeypatch.setattr(ui_server, "activate_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(ui_server, "save_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(
        ui_server,
        "load_changeset_harvest_ui",
        lambda *_args: type("Result", (), {"as_dict": lambda self: {"status": "requirements_ready"}})(),
    )

    payload = ui_server.rerun_design_stage(
        tmp_path,
        "CHG-001",
        "requirements-definition",
        "",
        answers=[
            {
                "question": "Which success condition was intended?",
                "recommended": "Use actor-visible save.",
                "answer": "Use saved-note availability.",
            }
        ],
    )

    assert payload["needs_input"] is True
    assert payload["pending_questions"] == [
        {
            "question": "Which success condition is canonical?",
            "recommended": "Use saved-note availability.",
        }
    ]
    encoded_answers = json.loads(calls[0]["HARNESS_INTERACTIVE_STAGE_ANSWERS"])
    assert encoded_answers[0]["answer"] == "Use saved-note availability."


def test_rerun_design_stage_marks_blocked_output_without_staling_downstream(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    change_set_path = _write_change_set(tmp_path)
    _write_documents(tmp_path)

    def fake_run(command, *, cwd, text, capture_output, check, stdin, env):
        return subprocess.CompletedProcess(
            command,
            0,
            "\n".join(
                [
                    "Stage: technical-decisions",
                    "Interactive status: blocked",
                    "Verification: skipped",
                    "ChangeSet status: blocked",
                    "Notes: technical decisions remain pending",
                ]
            ),
            "",
        )

    monkeypatch.setattr(ui_server.subprocess, "run", fake_run)
    monkeypatch.setattr(ui_server, "activate_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(ui_server, "save_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(
        ui_server,
        "load_changeset_harvest_ui",
        lambda *_args: type("Result", (), {"as_dict": lambda self: {"status": "blocked"}})(),
    )

    payload = ui_server.rerun_design_stage(
        tmp_path,
        "CHG-001",
        "technical-decisions",
        "",
        uc_id="UC-001",
    )

    assert payload["blocked"] is True
    assert payload["needs_input"] is False
    assert "ChangeSet status: blocked" in payload["output"]
    assert "|plan-writing|plan.md Writing|stale|" not in change_set_path.read_text(
        encoding="utf-8"
    )


def test_rerun_design_stage_allows_missing_prompt_and_requires_scoped_uc(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "Verification: passed\n", "")

    monkeypatch.setattr(ui_server.subprocess, "run", fake_run)
    monkeypatch.setattr(ui_server, "activate_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(ui_server, "save_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(
        ui_server,
        "load_changeset_harvest_ui",
        lambda *_args: type("Result", (), {"as_dict": lambda self: {"status": "requirements_ready"}})(),
    )

    ui_server.rerun_design_stage(
        tmp_path,
        "CHG-001",
        "requirements-definition",
        "",
    )

    assert calls == [
        [
                ui_server.sys.executable,
                "-m",
                "harness_codex",
                "--repo-root",
                str(tmp_path.resolve()),
                "requirements-definition",
            "CHG-001",
            "--force",
        ]
    ]
    with pytest.raises(ValueError, match="uc_id is required"):
        ui_server.rerun_design_stage(
            tmp_path,
            "CHG-001",
            "technical-decisions",
            "Use transactional outbox.",
        )
    with pytest.raises(ValueError, match="uc_id is required"):
        ui_server.rerun_design_stage(
            tmp_path,
            "CHG-001",
            "plan-writing",
            "Add rollback verification.",
        )


def test_rerun_plan_writing_stage_uses_scoped_use_case(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_change_set(tmp_path)
    calls: list[list[str]] = []

    def fake_run(command, *, cwd, text, capture_output, check, **_kwargs):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, "Verification: passed\n", "")

    monkeypatch.setattr(ui_server.subprocess, "run", fake_run)
    monkeypatch.setattr(ui_server, "activate_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(ui_server, "save_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(
        ui_server,
        "load_changeset_harvest_ui",
        lambda *_args: type("Result", (), {"as_dict": lambda self: {}})(),
    )

    ui_server.rerun_design_stage(
        tmp_path,
        "CHG-001",
        "plan-writing",
        "Add rollback verification.",
        uc_id="UC-001",
    )

    assert calls == [[
        ui_server.sys.executable,
        "-m",
        "harness_codex",
        "--repo-root",
        str(tmp_path.resolve()),
        "plan-writing",
        "CHG-001",
        "--idea",
        "Add rollback verification.",
        "--force",
        "--uc",
        "UC-001",
    ]]


def test_start_rerun_design_stage_returns_running_job_without_blocking(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    started: list[tuple[object, tuple[object, ...]]] = []

    class FakeThread:
        def __init__(self, *, target, args, daemon):
            assert daemon is True
            started.append((target, args))

        def start(self) -> None:
            return

    ui_server._STAGE_RERUN_JOBS.clear()
    monkeypatch.setattr(ui_server.threading, "Thread", FakeThread)

    payload = ui_server.start_rerun_design_stage(
        tmp_path,
        "CHG-001",
        "use-case-definition",
        "",
    )

    assert payload["job"]["status"] == "running"
    assert payload["job"]["stage_id"] == "use-case-definition"
    assert payload["job"]["elapsed_seconds"] >= 0
    assert payload["job"]["activity"] == []
    assert started[0][0] is ui_server._run_rerun_design_stage_job
    assert started[0][1][-2] == []
    assert started[0][1][-1] is False
    ui_server._STAGE_RERUN_JOBS.clear()


def test_start_rerun_technical_decisions_from_scratch_passes_restart(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    started: list[tuple[object, ...]] = []

    class FakeThread:
        def __init__(self, *, target, args, daemon):
            assert target is ui_server._run_rerun_design_stage_job
            assert daemon is True
            started.append(args)

        def start(self) -> None:
            return

    ui_server._STAGE_RERUN_JOBS.clear()
    monkeypatch.setattr(ui_server.threading, "Thread", FakeThread)

    payload = ui_server.start_rerun_design_stage(
        tmp_path,
        "CHG-001",
        "technical-decisions",
        "",
        uc_id="UC-001",
        restart=True,
    )

    assert payload["job"]["status"] == "running"
    assert started[0][-1] is True
    ui_server._STAGE_RERUN_JOBS.clear()


def test_rerun_technical_decisions_restart_runs_reset_script_before_stage(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _write_change_set(tmp_path)
    reset_script = (
        tmp_path
        / ".codex/skills/harness-reset-technical-decisions/scripts/reset.py"
    )
    reset_script.parent.mkdir(parents=True)
    reset_script.write_text("# fixture\n", encoding="utf-8")
    calls: list[list[str]] = []

    def fake_run(command, *, cwd, text, capture_output, check, **_kwargs):
        calls.append(command)
        if command[1].endswith("reset.py"):
            return subprocess.CompletedProcess(
                command,
                0,
                '{"stage_row_updated": true}',
                "",
            )
        return subprocess.CompletedProcess(command, 0, "Verification: passed\n", "")

    monkeypatch.setattr(ui_server.subprocess, "run", fake_run)
    monkeypatch.setattr(ui_server, "activate_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(ui_server, "save_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(
        ui_server,
        "load_changeset_harvest_ui",
        lambda *_args: type("Result", (), {"as_dict": lambda self: {}})(),
    )

    ui_server.rerun_design_stage(
        tmp_path,
        "CHG-001",
        "technical-decisions",
        "",
        uc_id="UC-001",
        restart=True,
    )

    assert calls[0][1].endswith(
        ".codex/skills/harness-reset-technical-decisions/scripts/reset.py"
    )
    assert calls[0][-4:] == ["--change-set", "CHG-001", "--uc", "UC-001"]
    assert "--restart" not in calls[1]
    assert calls[1][-2:] == ["--uc", "UC-001"]


def test_stage_rerun_progress_restores_needs_input_after_server_restart(
    tmp_path: Path,
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    job = {
        "change_set_id": "CHG-001",
        "stage_id": "technical-decisions",
        "uc_id": "UC-001",
        "status": "needs_input",
        "started_at": "2026-06-15T10:00:00",
        "started_at_epoch": 1.0,
        "finished_at": "2026-06-15T10:01:00",
        "finished_at_epoch": 2.0,
        "returncode": 0,
        "output": "Interactive status: needs_input",
        "error": "",
        "pending_questions": [
            {
                "question": "Should stored image bytes use AES-256-GCM?",
                "recommended": "Use AES-256-GCM for Java runtime support.",
            }
        ],
    }
    ui_server._STAGE_RERUN_JOBS.clear()
    ui_server._save_stage_rerun_job(tmp_path, job)

    payload = ui_server.stage_rerun_progress_state(tmp_path, "CHG-001")

    assert payload["job"]["status"] == "needs_input"
    assert payload["job"]["stage_id"] == "technical-decisions"
    assert payload["job"]["uc_id"] == "UC-001"
    assert payload["job"]["pending_questions"] == [
        {
            "question": "Should stored image bytes use AES-256-GCM?",
            "recommended": "Use AES-256-GCM for Java runtime support.",
        }
    ]
    ui_server._STAGE_RERUN_JOBS.clear()


def test_stage_rerun_progress_restores_latest_needs_input_session(
    tmp_path: Path,
) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    session_path = tmp_path / ".harness/runs/run-td/grill-me-session.json"
    session_path.parent.mkdir(parents=True)
    session_path.write_text(
        json.dumps(
            {
                "change_set_id": "CHG-001",
                "stage": "technical-decisions",
                "uc_id": "UC-001",
                "status": "needs_input",
                "pending_questions": [
                    {
                        "question": "Should asset storage use local filesystem?",
                        "recommended": "Use local filesystem for MVP.",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    ui_server._STAGE_RERUN_JOBS.clear()

    payload = ui_server.stage_rerun_progress_state(tmp_path, "CHG-001")

    assert payload["job"]["status"] == "needs_input"
    assert payload["job"]["stage_id"] == "technical-decisions"
    assert payload["job"]["uc_id"] == "UC-001"
    assert payload["job"]["pending_questions"][0]["question"] == (
        "Should asset storage use local filesystem?"
    )
    assert (
        tmp_path / ".harness/ui/stage-rerun-jobs/CHG-001.json"
    ).exists()
    ui_server._STAGE_RERUN_JOBS.clear()


def test_recent_agent_activity_projects_codex_summaries_and_commands(tmp_path: Path) -> None:
    stdout_path = tmp_path / ".harness/runs/run-001/steps/use-case/stdout.txt"
    stdout_path.parent.mkdir(parents=True)
    stdout_path.write_text(
        "\n".join(
            [
                '{"type":"thread.started","thread_id":"thread-1"}',
                '{"type":"turn.started"}',
                '{"type":"item.completed","item":{"type":"reasoning","text":"Checking use-case consistency."}}',
                '{"type":"item.completed","item":{"type":"command_execution","command":"rg -n UC-001 docs","status":"completed"}}',
                '{"type":"turn.completed","usage":{"output_tokens":321}}',
            ]
        ),
        encoding="utf-8",
    )

    activity = ui_server._recent_agent_activity(tmp_path, since=0)

    assert activity == [
        "Agent session started.",
        "Agent turn started.",
        "Reasoning summary: Checking use-case consistency.",
        "Command completed: rg -n UC-001 docs",
        "Agent turn completed. Output tokens: 321.",
    ]

def test_workflow_activity_state_returns_recent_agent_activity(tmp_path: Path) -> None:
    _write_change_set(tmp_path)
    stdout_path = tmp_path / ".harness/runs/run-001/steps/use-case/stdout.txt"
    stdout_path.parent.mkdir(parents=True)
    stdout_path.write_text(
        '{"type":"item.completed","item":{"type":"agent_message","text":"Use-case generation still running."}}\n',
        encoding="utf-8",
    )

    payload = ui_server.workflow_activity_state(tmp_path, "CHG-001", since=0)

    assert payload["change_set_id"] == "CHG-001"
    assert payload["elapsed_seconds"] == 0
    assert payload["activity"] == ["Agent summary: Use-case generation still running."]


def test_workflow_activity_state_reads_ui_ddd_run_activity(tmp_path: Path) -> None:
    _write_change_set(tmp_path)
    stdout_path = tmp_path / ".harness/ui/ddd-runs/interactive-ddd-run-all-001/step/stdout.txt"
    stdout_path.parent.mkdir(parents=True)
    stdout_path.write_text(
        "\n".join(
            [
                '{"type":"thread.started","thread_id":"thread-1"}',
                '{"type":"item.started","item":{"type":"command_execution","command":"sed -n 1,80p docs/use-cases/UC-030/ddd-design.md","status":"in_progress"}}',
                '{"type":"item.completed","item":{"type":"agent_message","text":"UC-030 후보 보강 중."}}',
            ]
        ),
        encoding="utf-8",
    )

    payload = ui_server.workflow_activity_state(tmp_path, "CHG-001", since=0)

    assert payload["activity"] == [
        "Agent session started.",
        "Command running: sed -n 1,80p docs/use-cases/UC-030/ddd-design.md",
        "Agent summary: UC-030 후보 보강 중.",
    ]


def test_ddd_complete_sticky_renders_one_prompt_input(tmp_path: Path) -> None:
    script = Path("harness_codex/runtime/dashboard_assets/dashboard.js").read_text(encoding="utf-8")
    script = script.split("loadDashboard().catch", 1)[0]
    node_script = (
        script
        + """
function __renderFor(state) {
  app.harvest = { ddd_architecture: state, event_storming: { complete: true } };
  app.requirementsChangeSet = "CHG-1";
  app.state = {
    change_sets: [{
      id: "CHG-1",
      documents: [{ kind: "technical-decisions", id: "technical-decisions:UC-001", label: "td" }],
      stages: [],
    }],
    project_documents: { lanes: [], document_count: 0 },
  };
  app.dddSelectedUc = state.current_uc || "UC-001";
  app.dddSelectedStep = state.current_step || "entity_vo";
  return renderDddArchitectureWorkspace();
}
const stepOrder = ["entity_vo", "behaviors", "application_flow", "aggregates", "bounded_contexts"].map((id) => ({ id, label: id }));
const steps = Object.fromEntries(stepOrder.map((step) => [step.id, { label: step.label, status: "complete", current_question: null }]));
const html = __renderFor({
  uc_ids: ["UC-001"],
  current_uc: null,
  current_step: null,
  completed_count: 5,
  total_count: 5,
  complete: true,
  status: "complete",
  step_order: stepOrder,
  items: { "UC-001": { status: "complete", steps } },
});
const textareaCount = (html.match(/<textarea/g) || []).length;
if (textareaCount !== 1) throw new Error(`expected one textarea, got ${textareaCount}`);
if (html.includes("ddd-rerun-prompt")) throw new Error("step rerun prompt should be hidden when complete");
if (!html.includes("workflow-rerun-prompt")) throw new Error("workflow correction prompt should remain");
"""
    )
    script_path = tmp_path / "ddd-complete-sticky-check.js"
    script_path.write_text(node_script, encoding="utf-8")
    subprocess.run(["node", str(script_path)], check=True)


def test_run_ui_server_prints_bind_url_and_endpoint_list(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class FakeServer:
        def serve_forever(self) -> None:
            return

        def server_close(self) -> None:
            return

    monkeypatch.setattr(ui_server, "_terminate_previous_ui_server", lambda _root, _host, _port: True)
    monkeypatch.setattr(
        ui_server,
        "_create_http_server",
        lambda _host, _port, _handler, *, wait_for_restart: FakeServer(),
    )

    ui_server.run_ui_server(tmp_path, host="127.0.0.1", port=43210)

    output = capsys.readouterr().out
    assert "Harness UI server running at http://127.0.0.1:43210" in output
    assert f"Repo root: {tmp_path.resolve()}" in output
    assert "Restarted previous UI server for this repo." in output
    assert "Exposed endpoints:" in output
    assert "http://127.0.0.1:43210/api/endpoints - endpoint discovery" in output
    assert "http://127.0.0.1:43210/api/dashboard - dashboard document state" in output
    assert "http://127.0.0.1:43210/api/dashboard/change-sets/{change_set_id}/implementation" in output
    assert "http://127.0.0.1:43210/api/ddd-architecture/answer" in output


def test_ui_server_logs_requests_to_stdout(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    class Handler(HarvestUiRequestHandler):
        repo_root = tmp_path

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urlopen(f"{base}/api/dashboard") as response:
            assert response.status == 200
    finally:
        server.shutdown()
        thread.join()
        server.server_close()

    output = capsys.readouterr().out
    assert '"GET /api/dashboard HTTP/1.1" 200 -' in output


def test_ui_server_root_serves_dashboard_with_new_changeset_action(tmp_path: Path) -> None:
    class Handler(HarvestUiRequestHandler):
        repo_root = tmp_path

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urlopen(f"{base}/") as response:
            html = response.read().decode("utf-8")
        with urlopen(f"{base}/assets/dashboard.js") as response:
            javascript = response.read().decode("utf-8")
        with urlopen(f"{base}/assets/dashboard.css") as response:
            stylesheet = response.read().decode("utf-8")
        assert "New ChangeSet" in html
        assert "Ubiquitous Language" in javascript
        assert '"/api/ubiquitous-language/start"' in javascript
        assert '"/api/ubiquitous-language/complete"' in javascript
        assert "Continue to Ubiquitous Language" in javascript
        assert "Confirm Ubiquitous Language" in javascript
        assert '"/api/use-cases/start"' in javascript
        assert "Resume Workflow" in javascript
        assert "/resume" in javascript
        assert "Continue to Use Case Definition" in javascript
        assert '<section class="panel"><h3>Requirements</h3><div id="editor"></div></section>' in javascript
        assert '<section class="panel"><h3>Ubiquitous Language</h3>${document}</section>' in javascript
        assert '<section class="panel"><h3>Use Case Document</h3>${document}</section>' in javascript
        assert '<section class="panel"><h3>${escapeHtml(currentId || "Technical Decisions")} Document</h3><div id="editor"></div></section>' in javascript
        assert "Submit all answers" in javascript
        assert 'document.querySelectorAll("[data-grill-answer]")' in javascript
        assert "JSON.stringify({ change_set_id: app.requirementsChangeSet, answers })" in javascript
        assert "Retry Use Case Definition" in javascript
        assert "Continue to Event Storming" in javascript
        assert "Continue Event Storming" in javascript
        assert '"/api/event-storming/start"' in javascript
        assert "renderEventDocumentEditor" in javascript
        assert "Continue to DDD Architecture" in javascript
        assert '"/api/ddd-architecture/start"' in javascript
        assert '"/api/ddd-architecture/run-all"' in javascript
        assert "Run All DDD Substeps" in javascript
        assert "scheduleDddPoll" in javascript
        assert 'fetch("/api/harvest")' in javascript
        assert "const runAllAgain" in javascript
        assert '"/api/ddd-architecture/restart"' in javascript
        assert '"/api/ddd-architecture/advance"' in javascript
        assert '"/api/ddd-architecture/rerun-step"' in javascript
        assert "/rerun-stage" in javascript
        assert "Rerun and verify" in javascript
        assert "Correction prompt (optional)" in javascript
        assert "Agent activity:" in javascript
        assert "not private chain-of-thought" in javascript
        assert "scheduleStageRerunPoll" in javascript
        assert "/activity?since=" in javascript
        assert "scheduleWorkflowActivityPoll" in javascript
        assert "renderWorkflowActivityPanel" in javascript
        assert "scheduleWorkflowRerunPoll" in javascript
        assert "renderPreservingScroll" in javascript
        assert "if (!stageId) return;" in javascript
        assert "if (!prompt || !stageId) return;" not in javascript
        assert "renderWorkflowRerunPanel" in javascript
        assert "submitWorkflowStageRerun" in javascript
        assert "currentRerunAnswerFromPrompt" in javascript
        assert "Submit answer and rerun" in javascript
        assert "Discard questions and restart from scratch" in javascript
        assert "restart: true" in javascript
        assert "Answer this Grill-Me question" in javascript
        assert "Rerun Technical Decisions" in javascript
        assert 'data-stage-tab="technicalDecisions"' in javascript
        assert '"/api/ddd-architecture/answer"' in javascript
        assert "Restart DDD Architecture" in javascript
        assert "Additional rerun prompt" in javascript
        assert "const showRerunControls = currentId" in javascript
        assert "state.status !== \"not_started\"" in javascript
        assert "status === \"needs_input\"" in javascript
        assert "Rerun ${escapeHtml(step.label)}" in javascript
        assert "renderDddVisualization" in javascript
        assert "renderMermaidDiagrams" in javascript
        assert "cdn.jsdelivr.net/npm/mermaid" in javascript
        assert '<pre class="mermaid">' in javascript
        assert "function richTextHtml" in javascript
        assert "function tableColumnClass" in javascript
        assert "function normalizeDddEntityVoRows" in javascript
        assert "renderDddCanvasBoard" in javascript
        assert "ddd-evolved-design" in javascript
        assert "ddd-aggregate-panel" in javascript
        assert "ddd-aggregate-name" in javascript
        assert "ddd-model-card" in javascript
        assert "ddd-root-badge" in javascript
        assert "ddd-service-box" in javascript
        assert "ddd-aggregate-services" in javascript
        assert "ddd-app-service-list" in javascript
        assert "ddd-model-section-tag" in javascript
        assert "attributes" in javascript
        assert "methods" in javascript
        assert "application service" in javascript
        assert "Entity/VO" not in javascript
        assert '? "vo" : "entity"' in javascript
        assert "dddVoReferenceRows" in javascript
        assert "dddAttributeDisplayLines" in javascript
        assert "splitDddAttributeParts" in javascript
        assert "dddModelProperties" in javascript
        assert '"VO References"' in javascript
        assert "ddd-entity-vo-row" in javascript
        assert "ddd-linked-vo-stack" in javascript
        assert "data-ddd-vo-source" in javascript
        assert "data-ddd-vo-target" in javascript
        assert "drawDddVoLinks" in javascript
        assert "boxClearance = 8" in javascript
        assert "routeY" in javascript
        assert "voArrowLinks" not in javascript
        assert "dddMethodLabel" in javascript
        assert "dddEntityMethodSignatures" in javascript
        assert "dddFlowDescription" in javascript
        assert "calls: " not in javascript
        assert "calls ->" not in javascript
        assert "dddFlowTouchesMembers(row, members, displayAggregateName)" in javascript
        assert "entity method" not in javascript
        assert "bindCanvas" in javascript
        assert "function renderGrillPanel" in javascript
        assert "function bindGrillPanel" in javascript
        assert "data-grill-panel-toggle" in javascript
        assert "grillPanelCollapsed" in javascript
        assert "function stickyText" in javascript
        assert "function eventFlowKind" in javascript
        assert "function applyDomainElementLabels" in javascript
        assert "function isEditingDashboardDocument" in javascript
        assert 'app.view === "dashboard" && !isEditingDashboardDocument()' in javascript
        assert 'if (event.target.closest(".sticky")) return;\n    event.preventDefault();' in javascript
        assert "function renderInline" in javascript
        assert ".ddd-flow { display: flex; flex-wrap: wrap;" in stylesheet
        assert "listItems.map" in javascript
        assert "runtime-progress" in stylesheet
        assert "stage-tabs" in stylesheet
        assert ".markdown-preview code" in stylesheet
        assert ".requirements-document .markdown-preview" not in stylesheet
        assert ".technical-document .markdown-preview" not in stylesheet
        assert ".markdown-table .column-long" in stylesheet
        assert "max-height: 180px" in stylesheet
        assert "max-width: min(1720px, calc(100vw - 48px))" in stylesheet
        assert ".event-canvas" in stylesheet
        assert ".ddd-aggregate-panel" in stylesheet
        assert ".grill-panel { margin-top: 24px; position: sticky; bottom: 14px;" in stylesheet
        assert ".grill-panel-header" in stylesheet
        assert ".grill-panel-toggle" in stylesheet
        assert "z-index: 20" in stylesheet
        assert ".ddd-model-card" in stylesheet
        assert ".ddd-entity-vo-row" in stylesheet
        assert ".ddd-vo-link-layer" in stylesheet
        assert ".ddd-vo-link-path" in stylesheet
        assert "padding-top: 70px" in stylesheet
        assert ".ddd-linked-vo::before" not in stylesheet
        assert ".ddd-linked-vo::after" not in stylesheet
        assert "flex: 0 0 320px" in stylesheet
        assert "minmax(74px, auto)" in stylesheet
        assert "overflow: visible" in stylesheet
        assert ".ddd-vo-card" in stylesheet
        assert "flex-basis: 220px" in stylesheet
        assert ".ddd-model-section-tag" in stylesheet
        assert ".ddd-app-service-list" in stylesheet
        assert ".ddd-service-box" in stylesheet
        assert ".ddd-grid" in stylesheet
        assert ".ddd-canvas { height: 720px; }" in stylesheet
        assert ".ddd-relations" in stylesheet
        assert ".ddd-link-target" in stylesheet
        assert "min-width: 1020px" in stylesheet
        assert "user-select: none" in stylesheet
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def test_start_requirements_changeset_serializes_harvest_result(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    result = type(
        "HarvestResult",
        (),
        {"as_dict": lambda self: {"status": "requirements_running", "current_question": {"question": "Who?"}}},
    )()
    monkeypatch.setattr(ui_server, "start_requirements", lambda _root, _prompt: result)
    monkeypatch.setattr(ui_server, "save_changeset_harvest_ui", lambda _root, _change_set_id: None)
    monkeypatch.setattr(ui_server, "_suggest_change_set_id", lambda _root: "CHG-20260526-099")

    payload = ui_server.start_requirements_changeset(tmp_path, "Build note capture")

    assert payload["harvest"]["status"] == "requirements_running"
    assert payload["change_set_id"] == "CHG-20260526-099"
    assert (tmp_path / "docs/changes/active/CHG-20260526-099.md").exists()


def test_answer_requirements_changeset_forwards_batched_answers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answers = ["Customer", "Request accepted", "Invalid request rejected"]
    received: list[list[str]] = []
    result = type(
        "HarvestResult",
        (),
        {"as_dict": lambda self: {"status": "requirements_passed"}},
    )()
    monkeypatch.setattr(ui_server, "activate_changeset_harvest_ui", lambda *_args: None)
    monkeypatch.setattr(
        ui_server,
        "answer_requirements",
        lambda _root, submitted: received.append(submitted) or result,
    )
    monkeypatch.setattr(ui_server, "save_changeset_harvest_ui", lambda *_args: None)

    payload = ui_server.answer_requirements_changeset(
        tmp_path,
        "CHG-20260611-001",
        answers,
    )

    assert received == [answers]
    assert payload["harvest"]["status"] == "requirements_passed"


def test_ui_server_loads_scoped_changeset_resume_without_starting_workflow(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    def fake_resume(_root: Path, change_set_id: str) -> dict:
        calls.append(change_set_id)
        return {
            "change_set_id": change_set_id,
            "harvest": {"status": "requirements_running", "current_question": {"question": "Continue?"}},
        }

    monkeypatch.setattr(ui_server, "resume_changeset", fake_resume)

    class Handler(HarvestUiRequestHandler):
        repo_root = tmp_path

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        with urlopen(f"{base}/api/dashboard/change-sets/CHG-20260526-001/resume") as response:
            payload = json.loads(response.read().decode("utf-8"))
        assert payload["change_set_id"] == "CHG-20260526-001"
        assert payload["harvest"]["current_question"]["question"] == "Continue?"
        assert calls == ["CHG-20260526-001"]
    finally:
        server.shutdown()
        thread.join()
        server.server_close()


def test_delete_active_changeset_removes_only_selected_active_file(tmp_path: Path) -> None:
    active_path = _write_change_set(tmp_path)
    _write_documents(tmp_path)
    completed_path = _write_change_set(tmp_path, "completed")

    payload = delete_active_changeset(tmp_path, "CHG-001")

    assert payload["id"] == "CHG-001"
    assert not active_path.exists()
    assert completed_path.exists()
    assert (tmp_path / "docs/design/요구사항.md").exists()


def test_delete_active_changeset_rejects_completed_changeset(tmp_path: Path) -> None:
    completed_path = _write_change_set(tmp_path, "completed")

    with pytest.raises(DashboardChangeSetNotFound, match="Active ChangeSet does not exist."):
        delete_active_changeset(tmp_path, "CHG-001")

    assert completed_path.exists()


def test_ui_server_deletes_selected_active_changeset(tmp_path: Path) -> None:
    _write_change_set(tmp_path)

    class Handler(HarvestUiRequestHandler):
        repo_root = tmp_path

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        request = Request(f"{base}/api/dashboard/change-sets/CHG-001", method="DELETE")
        with urlopen(request) as response:
            payload = json.loads(response.read().decode("utf-8"))
        assert payload["id"] == "CHG-001"
        assert not (tmp_path / "docs/changes/active/CHG-001.md").exists()
    finally:
        server.shutdown()
        thread.join()
        server.server_close()
