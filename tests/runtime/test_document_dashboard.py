from __future__ import annotations

import json
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
from harness_codex.runtime.models import RunStatus
from harness_codex.runtime.procedure_stages import render_initial_changeset
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

## 6. External Systems
|시스템|연동 목적|
|---|---|
|`Browser Store`|Persist draft|
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
        json.dumps({"requirements_gate_passed": True, "use_cases_ready": True}),
        encoding="utf-8",
    )
    canonical = root / ".harness/ui/change-sets/CHG-001/docs/design/유스케이스.md"
    canonical.parent.mkdir(parents=True, exist_ok=True)
    canonical.write_text("# Use Case Document\n\n- UC-001. Save Fleeting Note\n", encoding="utf-8")
    use_case = root / ".harness/ui/change-sets/CHG-001/docs/use-cases/UC-001/use-case.md"
    use_case.parent.mkdir(parents=True, exist_ok=True)
    use_case.write_text(USE_CASE_MARKDOWN, encoding="utf-8")


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
    work_item = change_set["work_items"][0]
    assert "docs/plans/completed/UC-001/plan.md" in {
        artifact["path"] for artifact in work_item["artifacts"]
    }
    flows = work_item["event_storming"]["flows"]
    assert [flow["kind"] for flow in flows] == ["main", "exception"]
    assert flows[0]["notes"][0] == {"type": "command", "text": "Save Fleeting Note"}
    assert flows[0]["notes"][1] == {"type": "event", "text": "Fleeting Note was saved"}


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


def test_dashboard_projects_completed_ui_workflow_and_generated_use_cases_document(tmp_path: Path) -> None:
    _write_change_set(tmp_path)
    _write_documents(tmp_path)
    _write_completed_ui_workflow(tmp_path)

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]
    statuses = {stage["id"]: stage["status"] for stage in change_set["stages"]}
    documents = {document["id"]: document for document in change_set["documents"]}

    assert statuses["requirements-definition"] == "verified"
    assert statuses["use-case-definition"] == "verified"
    assert documents["generated-use-cases:CHG-001"]["label"] == "Use Cases (Read only)"
    loaded = read_dashboard_document(tmp_path, "generated-use-cases:CHG-001")
    assert loaded["editable"] is False
    assert loaded["path"] == ".harness/ui/change-sets/CHG-001/docs/design/유스케이스.md"
    assert "UC-001. Save Fleeting Note" in loaded["content"]


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
        {"type": "event", "text": "Fleeting Note was saved"},
    ]
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
        content=loaded["content"].replace("`Fleeting Note` was saved", "`Fleeting Note` was stored"),
        revision=loaded["revision"],
    )
    assert "was stored" in saved["content"]
    assert "|ddd-architecture-definition|DDD Architecture Definition|stale|" in change_path.read_text(
        encoding="utf-8"
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
    assert "|use-case-definition|Use Case Definition|stale|" in change_text
    assert "|implementation|Implementation|stale|" in change_text
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
    assert "# ChangeSet CHG-001" in loaded["content"]
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
        assert payload["change_sets"][0]["id"] == "CHG-001"
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
        assert '"/api/use-cases/start"' in javascript
        assert "Resume Workflow" in javascript
        assert "/resume" in javascript
        assert "Continue to Use Case Definition" in javascript
        assert "Retry Use Case Definition" in javascript
        assert "Continue to Event Storming" in javascript
        assert "Continue Event Storming" in javascript
        assert '"/api/event-storming/start"' in javascript
        assert "renderEventDocumentEditor" in javascript
        assert "bindCanvas" in javascript
        assert "function stickyText" in javascript
        assert "function isEditingDashboardDocument" in javascript
        assert 'app.view === "dashboard" && !isEditingDashboardDocument()' in javascript
        assert 'if (event.target.closest(".sticky")) return;\n    event.preventDefault();' in javascript
        assert "function renderInline" in javascript
        assert "listItems.map" in javascript
        assert "runtime-progress" in stylesheet
        assert "stage-tabs" in stylesheet
        assert ".markdown-preview code" in stylesheet
        assert ".event-canvas" in stylesheet
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
