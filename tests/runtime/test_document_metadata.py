from __future__ import annotations

import hashlib
import json
from pathlib import Path

from harness_codex.runtime.document_metadata import (
    approval_status_from_metadata_or_markdown,
    ensure_generated_document_metadata,
    parse_front_matter,
)


def test_parse_front_matter_metadata_and_strip_legacy_body_tables() -> None:
    text = """---
approval_status: pending
contract_version: 1
doc_type: e2e_goal
source_docs:
  - docs/use-cases/UC-001/use-case.md
---
# E2E

|Item|Value|
|---|---|
|Approval Status|approved|
"""

    metadata = parse_front_matter(text)
    found, status = approval_status_from_metadata_or_markdown(text)

    assert metadata["doc_type"] == "e2e_goal"
    assert metadata["source_docs"] == ["docs/use-cases/UC-001/use-case.md"]
    assert found is True
    assert status == "pending"


def test_missing_front_matter_falls_back_to_markdown_approval_table() -> None:
    text = """# Technical Decisions

|Item|Value|
|---|---|
|Approval Status|approved|
"""

    found, status = approval_status_from_metadata_or_markdown(text)

    assert found is True
    assert status == "approved"


def test_contract_sidecar_checksum_updates_when_document_changes(tmp_path: Path) -> None:
    relative_path = Path("docs/plans/active/UC-001/plan.md")
    absolute_path = tmp_path / relative_path
    absolute_path.parent.mkdir(parents=True)
    absolute_path.write_text("# Plan\n", encoding="utf-8")

    sidecar = ensure_generated_document_metadata(
        tmp_path,
        relative_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        source_docs=(Path("docs/use-cases/UC-001/e2e-goal.md"),),
        status="active",
    )
    first_payload = json.loads((tmp_path / sidecar).read_text(encoding="utf-8"))
    first_text = absolute_path.read_text(encoding="utf-8")

    absolute_path.write_text(
        first_text + "\n- [ ] Add implementation task\n",
        encoding="utf-8",
    )
    ensure_generated_document_metadata(
        tmp_path,
        relative_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        source_docs=(Path("docs/use-cases/UC-001/e2e-goal.md"),),
        status="active",
    )
    second_text = absolute_path.read_text(encoding="utf-8")
    second_payload = json.loads((tmp_path / sidecar).read_text(encoding="utf-8"))

    assert first_payload["checksum"] != second_payload["checksum"]
    assert second_payload["checksum"] == hashlib.sha256(
        second_text.encode("utf-8")
    ).hexdigest()
    assert second_payload["doc_type"] == "plan"
    assert second_payload["upstream_docs"] == ["docs/use-cases/UC-001/e2e-goal.md"]
