"""Move durable step-transaction facts from SQLite into canonical XML state."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

from harness_codex.runtime.models import RunStatus, StepResult, StepStatus
from harness_codex.runtime.state import RunState, RunStateStore
from harness_codex.runtime.xml_state import find_run_state_path

_PATCHED_ATTR = "_harness_xml_step_ledger_patch_applied"
_LEDGER_KEY = "xml_step_ledger"


def apply_xml_step_ledger_patch() -> None:
    """Replace the SQLite durable ledger with XML-backed step metadata.

    ``StepTransactionStore`` remains as a compatibility type for the runner,
    but it no longer creates ``state.sqlite3``. Every transaction and artifact
    snapshot is stored under ``RunState.decision_results`` and therefore in the
    same XML document as the rest of the ChangeSet state.
    """

    from harness_codex.runtime import step_transaction_store as module

    Store = module.StepTransactionStore
    if getattr(Store, _PATCHED_ATTR, False):
        return

    def path(self: Store) -> Path:
        try:
            return find_run_state_path(self._repo_root, self._run_id)
        except FileNotFoundError:
            return self._repo_root / ".harness/state/changesets/_pending/state.xml"

    def init(self: Store, repo_root: Path | str, run_id: str) -> None:
        self._repo_root = Path(repo_root)
        self._run_id = run_id

    def begin(self: Store, step, context):
        state = _load_or_create(context)
        ledger = _ledger(state)
        entries = list(ledger["entries"])
        for entry in entries:
            if entry.get("state") == "RUNNING":
                entry["state"] = "INTERRUPTED"
                entry["result_status"] = StepStatus.BLOCKED.value
                entry["error"] = entry.get("error") or "runtime stopped before step transaction committed"
                entry["finished_at"] = module._now()
        work_item_id = module._work_item_id(context)
        attempts = [
            int(entry.get("attempt", 0))
            for entry in entries
            if entry.get("work_item_id") == work_item_id and entry.get("step_id") == step.id
        ]
        attempt = max(attempts, default=0) + 1
        transaction_id = int(ledger["next_transaction_id"])
        ledger["next_transaction_id"] = transaction_id + 1
        entries.append(
            {
                "transaction_id": transaction_id,
                "attempt": attempt,
                "run_id": context.run_id,
                "workflow_name": context.workflow_name,
                "change_set_id": module._change_set_id(context) or state.change_set_id,
                "work_item_id": work_item_id,
                "step_id": step.id,
                "step_kind": step.kind.value,
                "state": "RUNNING",
                "result_status": StepStatus.RUNNING.value,
                "started_at": module._now(),
                "finished_at": None,
                "error": None,
                "failure_kind": None,
                "artifacts": _artifact_snapshot(module, context, step, phase="before"),
            }
        )
        _save_ledger(context.repo_root, state, ledger, entries)
        return module.StepTransaction(transaction_id=transaction_id, attempt=attempt)

    def finish(self: Store, transaction, step, context, result: StepResult) -> StepResult:
        state = _load_or_create(context)
        ledger = _ledger(state)
        entries = list(ledger["entries"])
        final_result = result
        missing_outputs = module._missing_outputs(context.repo_root, tuple(step.outputs))
        if result.status is StepStatus.SUCCEEDED and missing_outputs:
            final_result = StepResult(
                step_id=result.step_id,
                status=StepStatus.FAILED,
                exit_code=result.exit_code,
                output_path=result.output_path,
                error="declared step outputs missing: " + ", ".join(str(path) for path in missing_outputs),
                failure_kind=result.failure_kind,
                metadata=dict(result.metadata),
            )
        target = next(
            (entry for entry in entries if int(entry.get("transaction_id", -1)) == transaction.transaction_id),
            None,
        )
        if target is None:
            raise ValueError(f"XML step transaction does not exist: {transaction.transaction_id}")
        artifacts = list(target.get("artifacts", []))
        artifacts.extend(_artifact_snapshot(module, context, step, phase="after"))
        target.update(
            {
                "state": module._transaction_state(final_result.status),
                "result_status": final_result.status.value,
                "failure_kind": final_result.failure_kind.value if final_result.failure_kind else None,
                "error": final_result.error,
                "finished_at": module._now(),
                "artifacts": artifacts,
            }
        )
        _save_ledger(context.repo_root, state, ledger, entries)
        return final_result

    Store.__init__ = init  # type: ignore[method-assign]
    Store.begin = begin  # type: ignore[method-assign]
    Store.finish = finish  # type: ignore[method-assign]
    Store.path = property(path)  # type: ignore[assignment]
    setattr(Store, _PATCHED_ATTR, True)


def _load_or_create(context) -> RunState:
    store = RunStateStore(context.repo_root)
    try:
        return store.load(context.run_id)
    except FileNotFoundError:
        work_item_id = str(context.metadata.get("active_work_item_id") or "")
        return RunState(
            run_id=context.run_id,
            change_set_id=str(context.metadata.get("change_set_id") or "UNSCOPED"),
            workflow_name=context.workflow_name,
            mode=context.mode,
            affected_use_cases=(work_item_id,) if work_item_id.startswith("UC-") else (),
            affected_work_items=(work_item_id,) if work_item_id else (),
            status=RunStatus.RUNNING,
        )


def _ledger(state: RunState) -> dict[str, Any]:
    decisions = dict(state.decision_results)
    raw = decisions.get(_LEDGER_KEY, {})
    if not isinstance(raw, dict):
        raw = {}
    entries = raw.get("entries", [])
    if not isinstance(entries, list):
        entries = []
    next_transaction_id = raw.get("next_transaction_id", 1)
    try:
        next_transaction_id = max(1, int(next_transaction_id))
    except (TypeError, ValueError):
        next_transaction_id = 1
    return {"decisions": decisions, "entries": entries, "next_transaction_id": next_transaction_id}


def _save_ledger(repo_root: Path | str, state: RunState, ledger: dict[str, Any], entries: list[dict[str, Any]]) -> None:
    decisions = dict(ledger["decisions"])
    decisions[_LEDGER_KEY] = {
        "next_transaction_id": ledger["next_transaction_id"],
        "entries": entries,
    }
    RunStateStore(repo_root).save(replace(state, decision_results=decisions))


def _artifact_snapshot(module, context, step, *, phase: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    paths = tuple(step.inputs) if phase == "before" else tuple(step.outputs)
    role = "input" if phase == "before" else "output"
    for path in paths:
        exists, kind, checksum, size_bytes = module._artifact_facts(context.repo_root / path)
        records.append(
            {
                "path": str(path),
                "role": role,
                "phase": phase,
                "exists": exists,
                "kind": kind,
                "checksum": checksum,
                "size_bytes": size_bytes,
            }
        )
    for path in module._changed_files(context.repo_root):
        exists, kind, checksum, size_bytes = module._artifact_facts(context.repo_root / path)
        records.append(
            {
                "path": str(path),
                "role": "changed_file",
                "phase": phase,
                "exists": exists,
                "kind": kind,
                "checksum": checksum,
                "size_bytes": size_bytes,
            }
        )
    return records
