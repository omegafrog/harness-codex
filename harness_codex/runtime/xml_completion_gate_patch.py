"""Replace ChangeSet completion JSON readers with canonical XML state."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Mapping

_PATCHED = "_harness_xml_completion_gate_patch_applied"


def apply_xml_completion_gate_patch() -> None:
    """Use RunState and finalization XML only for completion decisions."""

    from harness_codex.runtime import completion
    from harness_codex.runtime.models import RunStatus
    from harness_codex.runtime.state import RunStateStore
    from harness_codex.runtime.xml_handoff import read_handoff

    if getattr(completion, _PATCHED, False):
        return

    def latest_run_id(root: Path, change_set_id: str) -> str | None:
        states = [
            state
            for state in RunStateStore(root).list_states()
            if state.change_set_id == change_set_id
            and not state.run_id.startswith("changeset-state-")
        ]
        if not states:
            return None
        return sorted(state.run_id for state in states)[-1]

    def successful_run(root: Path, run_id: str, work_item_ids: tuple[str, ...]):
        try:
            state = RunStateStore(root).load(run_id)
        except (FileNotFoundError, ValueError) as exc:
            raise completion.ChangeSetCompletionBlocked(
                f"canonical XML run state is missing: {run_id}"
            ) from exc
        selected = set(work_item_ids)
        blocked = selected & (set(state.blocked_work_items) | set(state.blocked_use_cases))
        if blocked:
            raise completion.ChangeSetCompletionBlocked(
                "canonical XML state contains blocked work items: " + ", ".join(sorted(blocked))
            )
        item_states = {item.work_item_id: item for item in state.work_item_states}
        use_case_states = {item.uc_id: item for item in state.use_case_states}
        reports: list[dict[str, Any]] = []
        for item_id in work_item_ids:
            item = item_states.get(item_id) or use_case_states.get(item_id)
            if item is None or item.status is not RunStatus.SUCCEEDED:
                raise completion.ChangeSetCompletionBlocked(
                    f"canonical XML state has no succeeded work item: {item_id}"
                )
            verdict = item.last_verifier_result
            if not isinstance(verdict, Mapping) or verdict.get("status") != "PASS":
                raise completion.ChangeSetCompletionBlocked(
                    f"canonical XML verification verdict is not PASS: {item_id}"
                )
            reports.append(
                {
                    "work_item_id": item_id,
                    "status": "succeeded",
                    "verification_goal_path": str(getattr(item, "active_plan_path", "-")),
                }
            )
        report = {
            "status": "succeeded" if state.status is RunStatus.SUCCEEDED else state.status.value,
            "work_item_reports": reports,
            "failed_use_cases": list(state.blocked_use_cases),
            "blocked_use_cases": list(state.blocked_use_cases),
        }
        return report, Path(".harness/state/changesets") / state.change_set_id / "state.xml"

    def retryable_finalization(root: Path, *, run_id: str, report: Mapping[str, Any], work_item_ids: tuple[str, ...]) -> bool:
        del report, work_item_ids
        path = root / ".harness/runs" / run_id / "finalization" / "report.xml"
        try:
            verdict = read_handoff(path, expected_type="finalization-report")
        except ValueError:
            return False
        return (
            verdict.get("status") in {"failed", "blocked"}
            and verdict.get("failed_step_id") == "create-change-set-pr"
        )

    completion._latest_run_id_for_change_set = latest_run_id
    completion._load_successful_run_report = successful_run
    completion._is_retryable_finalization_report = retryable_finalization
    setattr(completion, _PATCHED, True)
