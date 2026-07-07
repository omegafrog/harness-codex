"""Commit step ledger and RunState transitions in one ChangeSet XML transaction."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

from harness_codex.runtime.models import RunStatus, StepResult, StepStatus
from harness_codex.runtime.state import RunFailureKind, RunState, UseCaseStep
from harness_codex.runtime.xml_handoff import read_handoff
from harness_codex.runtime.xml_state_transaction import change_set_transaction

_PATCHED_ATTR = "_harness_xml_step_ledger_patch_applied"
_LEDGER_KEY = "xml_step_ledger"


def apply_xml_step_ledger_patch() -> None:
    """Make each step intent/outcome a single XML transaction.

    A command is never run under a document lock. ``begin`` atomically records
    the RUNNING intent and current-step state; ``finish`` atomically records the
    final result, artifact snapshot, verifier verdict, and work-item state.
    """

    from harness_codex.runtime import step_transaction_store as module

    Store = module.StepTransactionStore
    if getattr(Store, _PATCHED_ATTR, False):
        return

    def path(self: Store) -> Path:
        try:
            from harness_codex.runtime.xml_state import find_run_state_path

            return find_run_state_path(self._repo_root, self._run_id)
        except FileNotFoundError:
            return self._repo_root / ".harness/state/changesets/_pending/state.xml"

    def init(self: Store, repo_root: Path | str, run_id: str) -> None:
        self._repo_root = Path(repo_root)
        self._run_id = run_id

    def begin(self: Store, step, context):
        change_set_id = _change_set_id(context)
        with change_set_transaction(context.repo_root, change_set_id) as transaction:
            state = transaction.load_run_state(context.run_id) or _new_state(context)
            ledger = _ledger(state)
            entries = list(ledger["entries"])
            for entry in entries:
                if entry.get("state") == "RUNNING":
                    entry.update(
                        {
                            "state": "INTERRUPTED",
                            "result_status": StepStatus.BLOCKED.value,
                            "error": entry.get("error") or "runtime stopped before step transaction committed",
                            "finished_at": module._now(),
                        }
                    )
            work_item_id = module._work_item_id(context)
            attempts = [
                int(entry.get("attempt", 0))
                for entry in entries
                if entry.get("work_item_id") == work_item_id and entry.get("step_id") == step.id
            ]
            transaction_id = int(ledger["next_transaction_id"])
            ledger["next_transaction_id"] = transaction_id + 1
            entries.append(
                {
                    "transaction_id": transaction_id,
                    "attempt": max(attempts, default=0) + 1,
                    "run_id": context.run_id,
                    "workflow_name": context.workflow_name,
                    "change_set_id": change_set_id,
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
            transaction.save_run_state(
                _with_ledger_and_step_state(
                    state,
                    ledger,
                    entries,
                    context=context,
                    step=step,
                    status=StepStatus.RUNNING,
                    transaction_id=transaction_id,
                )
            )
        return module.StepTransaction(transaction_id=transaction_id, attempt=max(attempts, default=0) + 1)

    def finish(self: Store, transaction, step, context, result: StepResult) -> StepResult:
        change_set_id = _change_set_id(context)
        final_result = result
        with change_set_transaction(context.repo_root, change_set_id) as xml_transaction:
            state = xml_transaction.load_run_state(context.run_id) or _new_state(context)
            ledger = _ledger(state)
            entries = list(ledger["entries"])
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
            entry = next(
                (item for item in entries if int(item.get("transaction_id", -1)) == transaction.transaction_id),
                None,
            )
            if entry is None:
                raise ValueError(f"XML step transaction does not exist: {transaction.transaction_id}")
            artifacts = list(entry.get("artifacts", []))
            artifacts.extend(_artifact_snapshot(module, context, step, phase="after"))
            entry.update(
                {
                    "state": module._transaction_state(final_result.status),
                    "result_status": final_result.status.value,
                    "failure_kind": final_result.failure_kind.value if final_result.failure_kind else None,
                    "error": final_result.error,
                    "finished_at": module._now(),
                    "artifacts": artifacts,
                }
            )
            xml_transaction.save_run_state(
                _with_ledger_and_step_state(
                    state,
                    ledger,
                    entries,
                    context=context,
                    step=step,
                    status=final_result.status,
                    transaction_id=transaction.transaction_id,
                    result=final_result,
                )
            )
        return final_result

    Store.__init__ = init  # type: ignore[method-assign]
    Store.begin = begin  # type: ignore[method-assign]
    Store.finish = finish  # type: ignore[method-assign]
    Store.path = property(path)  # type: ignore[assignment]
    setattr(Store, _PATCHED_ATTR, True)


def _with_ledger_and_step_state(
    state: RunState,
    ledger: dict[str, Any],
    entries: list[dict[str, Any]],
    *,
    context,
    step,
    status: StepStatus,
    transaction_id: int,
    result: StepResult | None = None,
) -> RunState:
    decisions = dict(ledger["decisions"])
    decisions[_LEDGER_KEY] = {
        "next_transaction_id": ledger["next_transaction_id"],
        "entries": entries,
    }
    decisions["last_step_transition"] = {
        "transaction_id": transaction_id,
        "step_id": step.id,
        "status": status.value,
        "work_item_id": _work_item_id(context),
    }
    verdict = _verification_verdict(context, step)
    if verdict is not None:
        decisions["last_verification_handoff"] = verdict

    item_id = _work_item_id(context)
    run_status = _run_status(status)
    failure_kind = _run_failure_kind(result)
    blocker = result.error if result and status in {StepStatus.FAILED, StepStatus.BLOCKED} else None
    current_step = _coarse_step(step.id, state.current_step_id)
    work_items = tuple(
        replace(
            item,
            status=run_status,
            current_step_id=step.id,
            verification_status=(str(verdict.get("status", "")) if verdict else item.verification_status),
            last_executor_result=(dict(result.metadata) if result and "execute" in step.id else item.last_executor_result),
            last_verifier_result=(verdict or item.last_verifier_result),
            failure_kind=failure_kind if blocker else None,
            blocker=blocker,
        )
        if item.work_item_id == item_id else item
        for item in state.work_item_states
    )
    use_cases = tuple(
        replace(
            item,
            status=run_status,
            current_step_id=current_step,
            verification_status=(str(verdict.get("status", "")) if verdict else item.verification_status),
            last_executor_result=(dict(result.metadata) if result and "execute" in step.id else item.last_executor_result),
            last_verifier_result=(verdict or item.last_verifier_result),
            failure_kind=failure_kind if blocker else None,
            blocker=blocker,
        )
        if item.uc_id == item_id else item
        for item in state.use_case_states
    )
    return replace(
        state,
        current_use_case_id=item_id if item_id.startswith("UC-") else state.current_use_case_id,
        current_work_item_id=item_id or state.current_work_item_id,
        current_step_id=current_step,
        status=run_status,
        failed_step_id=step.id if blocker else None,
        failure_kind=failure_kind if blocker else None,
        decision_results=decisions,
        use_case_states=use_cases,
        work_item_states=work_items,
    )


def _verification_verdict(context, step) -> dict[str, Any] | None:
    if step.id != "verify-work-item":
        return None
    path = (
        context.repo_root
        / ".harness/runs"
        / context.run_id
        / "work-items"
        / _work_item_id(context)
        / "verification/verification.xml"
    )
    try:
        return read_handoff(path, expected_type="verification-report")
    except ValueError:
        return None


def _run_status(status: StepStatus) -> RunStatus:
    if status is StepStatus.BLOCKED:
        return RunStatus.BLOCKED
    if status is StepStatus.FAILED:
        return RunStatus.FAILED
    return RunStatus.RUNNING


def _run_failure_kind(result: StepResult | None) -> RunFailureKind | None:
    if result is None or result.failure_kind is None:
        return None
    mapping = {
        "implementation": RunFailureKind.IMPLEMENTATION_FAILURE,
        "environment": RunFailureKind.ENVIRONMENT_BLOCKER,
        "scope": RunFailureKind.SCOPE_CONFLICT,
        "plan_review": RunFailureKind.PLAN_REVIEW_REJECTED,
    }
    return mapping.get(str(result.failure_kind.value))


def _coarse_step(step_id: str, previous: UseCaseStep | None) -> UseCaseStep | None:
    lowered = step_id.casefold()
    if "plan" in lowered:
        return UseCaseStep.PLAN
    if "execute" in lowered:
        return UseCaseStep.EXECUTE
    if "verify" in lowered:
        return UseCaseStep.VERIFY
    if "security" in lowered:
        return UseCaseStep.SECURITY
    if "complete" in lowered:
        return UseCaseStep.COMPLETE
    return previous


def _new_state(context) -> RunState:
    item_id = _work_item_id(context)
    return RunState(
        run_id=context.run_id,
        change_set_id=_change_set_id(context),
        workflow_name=context.workflow_name,
        mode=context.mode,
        affected_use_cases=(item_id,) if item_id.startswith("UC-") else (),
        affected_work_items=(item_id,) if item_id else (),
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
    try:
        next_id = max(1, int(raw.get("next_transaction_id", 1)))
    except (TypeError, ValueError):
        next_id = 1
    return {"decisions": decisions, "entries": entries, "next_transaction_id": next_id}


def _artifact_snapshot(module, context, step, *, phase: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    paths = tuple(step.inputs) if phase == "before" else tuple(step.outputs)
    role = "input" if phase == "before" else "output"
    for path in paths:
        exists, kind, checksum, size_bytes = module._artifact_facts(context.repo_root / path)
        records.append({"path": str(path), "role": role, "phase": phase, "exists": exists, "kind": kind, "checksum": checksum, "size_bytes": size_bytes})
    for path in module._changed_files(context.repo_root):
        exists, kind, checksum, size_bytes = module._artifact_facts(context.repo_root / path)
        records.append({"path": str(path), "role": "changed_file", "phase": phase, "exists": exists, "kind": kind, "checksum": checksum, "size_bytes": size_bytes})
    return records


def _change_set_id(context) -> str:
    value = context.metadata.get("change_set_id")
    if value in (None, ""):
        raise ValueError("XML step transaction requires change_set_id in RunContext metadata")
    return str(value)


def _work_item_id(context) -> str:
    value = context.metadata.get("active_work_item_id")
    return str(value) if value not in (None, "") else ""
