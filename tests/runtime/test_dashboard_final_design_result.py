from __future__ import annotations

import hashlib
import json
from pathlib import Path

import harness_codex.runtime  # install dashboard projections
from harness_codex.runtime.document_dashboard import document_dashboard_state
from harness_codex.runtime.procedure_stages import render_initial_changeset


ROOT = Path(__file__).resolve().parents[2]


def _write_change_set(root: Path, change_set_id: str) -> None:
    path = root / "docs/changes/active" / f"{change_set_id}.md"
    path.parent.mkdir(parents=True)
    path.write_text(
        render_initial_changeset(
            change_set_id=change_set_id,
            title="Show final design diagrams",
            request_summary="Render verified diagrams in delivery.",
        )
        + """
## 5. Affected Use Cases

|UC ID|Use Case Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|
|`UC-001`|Save Note|add|`docs/use-cases/UC-001`|ready|
""",
        encoding="utf-8",
    )


def _write_verified_diagrams(root: Path, change_set_id: str) -> None:
    uc_id = "UC-001"
    slice_path = root / "docs/use-cases" / uc_id
    slice_path.mkdir(parents=True)
    sources = {
        slice_path / "use-case.md": "# Use Case\n",
        slice_path / "e2e-goal.md": "# E2E Goal\n",
        slice_path / "event-storming.md": "# Event Storming\n",
        slice_path / "ddd-design.md": "# DDD Design\n",
        slice_path / "technical-decisions.md": "# Technical Decisions\n",
        root / "context.md": "# Context\n",
        root / "ARCHITECTURE.md": "# Architecture\n",
    }
    for path, content in sources.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    (slice_path / "class-diagram.md").write_text(
        "# Class\n\n```mermaid\nclassDiagram\n    class Note\n```\n",
        encoding="utf-8",
    )
    (slice_path / "flow-diagram.md").write_text(
        "# Flow\n\n```mermaid\nflowchart TD\n    A --> B\n```\n",
        encoding="utf-8",
    )
    hashes = {
        str(path.relative_to(root)): f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"
        for path in sources
    }
    (slice_path / "diagram-metadata.json").write_text(
        json.dumps(
            {
                "change_set_id": change_set_id,
                "uc_id": uc_id,
                "status": "verified",
                "source_documents": hashes,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )


def test_dashboard_exposes_verified_class_and_flow_diagrams_as_final_results(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-901"
    _write_change_set(tmp_path, change_set_id)
    _write_verified_diagrams(tmp_path, change_set_id)

    change_set = document_dashboard_state(tmp_path)["change_sets"][0]

    assert change_set["final_design_visualizations"] == [
        {
            "uc_id": "UC-001",
            "status": "verified",
            "problems": [],
            "class_diagram": "# Class\n\n```mermaid\nclassDiagram\n    class Note\n```\n",
            "flow_diagram": "# Flow\n\n```mermaid\nflowchart TD\n    A --> B\n```\n",
        }
    ]


def test_dashboard_marks_stale_diagrams_but_final_ui_can_filter_them(tmp_path: Path) -> None:
    change_set_id = "CHG-20260625-902"
    _write_change_set(tmp_path, change_set_id)
    _write_verified_diagrams(tmp_path, change_set_id)
    (tmp_path / "context.md").write_text("# Changed Context\n", encoding="utf-8")

    diagram = document_dashboard_state(tmp_path)["change_sets"][0]["final_design_visualizations"][0]

    assert diagram["status"] == "stale"
    assert any("stale diagram source hash for context.md" in problem for problem in diagram["problems"])


def test_dashboard_delivery_result_contract_renders_only_verified_diagrams() -> None:
    html = (ROOT / "harness_codex/runtime/dashboard_assets/dashboard.html").read_text(
        encoding="utf-8"
    )

    assert "#refresh-delivery" in html
    assert "final_design_visualizations" in html
    assert 'item.status === "verified"' in html
    assert "Class Diagram" in html
    assert "Flow Diagram" in html
