from __future__ import annotations

from dataclasses import replace as dataclass_replace
from pathlib import Path

import pytest

from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.dashboard_runtime_state import canonical_run_id
from harness_codex.runtime.state import RunState, RunStateStore
from harness_codex.runtime.xml_state import XmlStateValidationError, change_set_state_path
from harness_codex.runtime.xml_state_store_patch import apply_xml_state_store_patch


def _state(run_id: str, change_set_id: str = "CHG-XML-001") -> RunState:
    return RunState(
        run_id=run_id,
        change_set_id=change_set_id,
        workflow_name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        affected_use_cases=("UC-020",),
        affected_work_items=("UC-020",),
        status=RunStatus.RUNNING,
        decision_results={"owner": "runtime", "flags": ["xml", "canonical"]},
    )


def test_run_state_store_uses_one_xml_document_per_change_set(tmp_path: Path) -> None:
    apply_xml_state_store_patch()
    store = RunStateStore(tmp_path)
    store.save(_state("run-1"))
    store.save(_state("run-2"))

    path = change_set_state_path(tmp_path, "CHG-XML-001")
    assert path.exists()
    assert path.read_text(encoding="utf-8").startswith("<?xml")
    assert "runId=\"run-1\"" in path.read_text(encoding="utf-8")
    assert "runId=\"run-2\"" in path.read_text(encoding="utf-8")
    assert not (tmp_path / ".harness/runs/run-1/state.json").exists()
    assert not (tmp_path / ".harness/runs/run-1/state.sqlite3").exists()

    restored = store.load("run-2")
    assert restored == _state("run-2")
    assert {state.run_id for state in store.list_states()} == {
        canonical_run_id("CHG-XML-001"),
        "run-1",
        "run-2",
    }


def test_xml_state_store_refreshes_legacy_dashboard_projection(tmp_path: Path) -> None:
    apply_xml_state_store_patch()
    store = RunStateStore(tmp_path)
    store.save(_state("run-1"))

    snapshot = tmp_path / ".harness/dashboard/runs/run-1.json"
    canonical_snapshot = (
        tmp_path / ".harness/dashboard/runs" / f"{canonical_run_id('CHG-XML-001')}.json"
    )
    index = tmp_path / ".harness/dashboard/index.json"

    assert snapshot.is_file()
    assert canonical_snapshot.is_file()
    assert '"run_id": "run-1"' in index.read_text(encoding="utf-8")

    store.save(dataclass_replace(_state("run-1"), status=RunStatus.SUCCEEDED))

    assert '"status": "succeeded"' in snapshot.read_text(encoding="utf-8")


def test_state_store_rejects_invalid_fixed_status_contract(tmp_path: Path) -> None:
    apply_xml_state_store_patch()
    path = change_set_state_path(tmp_path, "CHG-XML-002")
    path.parent.mkdir(parents=True)
    path.write_text(
        """<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<harness-state xmlns=\"urn:harness:state:v1\" schemaVersion=\"1\" changeSetId=\"CHG-XML-002\">
  <runs>
    <run-state runId=\"run-1\" changeSetId=\"CHG-XML-002\" workflowName=\"workflow\" mode=\"apply\" status=\"complete\">
      <affected-use-cases/><affected-work-items/><completed-use-cases/><completed-work-items/>
      <blocked-use-cases/><blocked-work-items/><current/><use-case-states/><work-item-states/>
      <artifact-states/><decision-results><value kind=\"map\"/></decision-results>
    </run-state>
  </runs>
</harness-state>
""",
        encoding="utf-8",
    )

    with pytest.raises(XmlStateValidationError, match="invalid status"):
        RunStateStore(tmp_path).load("run-1")
