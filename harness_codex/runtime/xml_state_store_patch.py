"""Install the canonical XML state store behind the existing RunStateStore API.

This is intentionally a narrow compatibility seam. Runtime callers continue to
use ``RunStateStore`` while persistence moves from per-run JSON files to the
single ChangeSet XML document. The patch also makes the dashboard enumerate
XML-backed runs rather than scanning ``.harness/runs/**/state.json``.
"""

from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.xml_state import (
    change_set_state_path,
    find_run_state_path,
    list_run_states,
    load_run_state,
    save_run_state,
)

_PATCHED_ATTR = "_harness_xml_state_store_patch_applied"


def apply_xml_state_store_patch() -> None:
    """Make XML the only durable RunState source used by runtime readers/writers."""

    from harness_codex.runtime import dashboard
    from harness_codex.runtime.changes.models import WorkItemType
    from harness_codex.runtime.dashboard import DashboardRun
    from harness_codex.runtime.state import RunStateStore
    from harness_codex.runtime.xml_harvest_state_patch import apply_xml_harvest_state_patch
    from harness_codex.runtime.xml_ui_state import install_xml_ui_state_extension

    install_xml_ui_state_extension()
    apply_xml_harvest_state_patch()

    if getattr(RunStateStore, _PATCHED_ATTR, False):
        return

    def state_path(self: RunStateStore, identifier: str) -> Path:
        """Return the ChangeSet XML document containing a known run.

        New documents are created by ``save`` because a run id alone does not
        identify its ChangeSet. Passing a ChangeSet id is useful for inspection
        before the first run exists.
        """

        if identifier.startswith("CHG-"):
            return change_set_state_path(self.repo_root, identifier)
        return find_run_state_path(self.repo_root, identifier)

    def save(self: RunStateStore, state):
        path = save_run_state(self.repo_root, state)
        # Once a ChangeSet state exists, replace every remaining UI-server
        # compatibility binding (including stage-rerun JSON jobs) with XML.
        from harness_codex.runtime.xml_ui_state_patch import apply_xml_ui_state_patch

        apply_xml_ui_state_patch()
        return path

    def load(self: RunStateStore, run_id: str):
        return load_run_state(self.repo_root, run_id)

    def list_states(self: RunStateStore):
        return list_run_states(self.repo_root)

    RunStateStore.state_path = state_path  # type: ignore[method-assign]
    RunStateStore.save = save  # type: ignore[method-assign]
    RunStateStore.load = load  # type: ignore[method-assign]
    RunStateStore.list_states = list_states  # type: ignore[attr-defined]
    setattr(RunStateStore, _PATCHED_ATTR, True)

    def load_dashboard_runs_from_xml(repo_root: Path | str):
        root = Path(repo_root)
        store = RunStateStore(root)
        runs = []
        for state in store.list_states():
            work_items = [
                dashboard._dashboard_work_item(
                    root,
                    state.run_id,
                    item.work_item_id,
                    item.work_item_type,
                    item.active_plan_path,
                    item.current_step_id,
                    item.status,
                    item.blocker or "",
                    item.verification_status,
                )
                for item in state.work_item_states
            ]
            if not work_items:
                work_items = [
                    dashboard._dashboard_work_item(
                        root,
                        state.run_id,
                        item.uc_id,
                        WorkItemType.USE_CASE,
                        item.active_plan_path,
                        item.current_step_id.value,
                        item.status,
                        item.blocker or "",
                        item.verification_status,
                    )
                    for item in state.use_case_states
                ]
            runs.append(
                DashboardRun(
                    run_id=state.run_id,
                    change_set_id=state.change_set_id,
                    status=state.status,
                    work_items=tuple(work_items),
                    report_path=Path(".harness/state/changesets")
                    / state.change_set_id
                    / "state.xml",
                )
            )
        return tuple(runs)

    dashboard.load_dashboard_runs = load_dashboard_runs_from_xml

    # The runner's old SQLite transaction class keeps its public API, but its
    # durable facts now share this XML source with every other runtime status.
    from harness_codex.runtime.xml_step_ledger_patch import apply_xml_step_ledger_patch

    apply_xml_step_ledger_patch()
