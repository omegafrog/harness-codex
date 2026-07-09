from __future__ import annotations

from pathlib import Path

import pytest

from harness_codex.runtime.changes.models import AffectedWorkItem, WorkItemType
from harness_codex.runtime.changes.work_item_documents import scaffold_work_item_documents
from harness_codex.runtime.xml_handoff import (
    XmlHandoffValidationError,
    read_handoff,
    write_handoff,
)


def _maintenance_item() -> AffectedWorkItem:
    return AffectedWorkItem(
        work_item_id="MAINT-001",
        work_item_type=WorkItemType.MAINTENANCE,
        name="Runtime cleanup",
        impact_type="maintenance",
        slice_path=Path("docs/maintenance/MAINT-001"),
    )


def test_read_frontier_handoff_round_trips_as_advisory_contract(tmp_path: Path) -> None:
    path = tmp_path / "read-frontier.xml"

    write_handoff(
        path,
        "read-frontier",
        {
            "schema_version": 1,
            "work_item_id": "MAINT-001",
            "advisory_only": True,
            "entries": [
                {
                    "path": "harness_codex/runtime/changes/work_item_documents.py",
                    "reason": "scaffold behavior starts here",
                }
            ],
            "notes": ["Suggested first reads only; not a write allowlist."],
        },
    )

    payload = read_handoff(path, expected_type="read-frontier")

    assert payload["work_item_id"] == "MAINT-001"
    assert payload["advisory_only"] is True
    assert payload["entries"][0]["path"] == "harness_codex/runtime/changes/work_item_documents.py"


def test_read_frontier_rejects_write_allowlist_semantics(tmp_path: Path) -> None:
    with pytest.raises(XmlHandoffValidationError, match="advisory_only=true"):
        write_handoff(
            tmp_path / "read-frontier.xml",
            "read-frontier",
            {
                "schema_version": 1,
                "work_item_id": "MAINT-001",
                "advisory_only": False,
                "entries": [],
                "notes": [],
            },
        )


def test_maintenance_scaffold_creates_read_frontier_xml_without_scope_md(tmp_path: Path) -> None:
    item = _maintenance_item()

    created = scaffold_work_item_documents(tmp_path, item)

    assert item.slice_path / "read-frontier.xml" in created
    assert item.slice_path / "scope.md" not in created
    assert not (tmp_path / item.slice_path / "scope.md").exists()

    payload = read_handoff(tmp_path / item.slice_path / "read-frontier.xml", expected_type="read-frontier")
    assert payload["advisory_only"] is True
    assert payload["entries"] == []
    assert any("not a write allowlist" in note for note in payload["notes"])
