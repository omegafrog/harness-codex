from __future__ import annotations

from harness_codex.runtime.models import RunMode, RunStatus
from harness_codex.runtime.dashboard_runtime_state import canonical_run_id
from harness_codex.runtime.state import RunState
from harness_codex.runtime.xml_state import list_run_states
from harness_codex.runtime.xml_state_transaction import change_set_transaction


def test_execution_save_also_upserts_canonical_state(tmp_path):
    state = RunState(
        run_id="run-xml-tx",
        change_set_id="CHG-XML-TX-001",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        affected_work_items=("MAINT-001",),
        status=RunStatus.RUNNING,
    )

    with change_set_transaction(tmp_path, state.change_set_id) as transaction:
        transaction.save_run_state(state)

    run_ids = {item.run_id for item in list_run_states(tmp_path)}
    assert state.run_id in run_ids
    assert canonical_run_id(state.change_set_id) in run_ids
