"""Route procedure-stage status through canonical ChangeSet RunState.

The ChangeSet Markdown table is a display mirror. Direct stage commands may still
run to prepare artifacts, while UI and explicit downstream gates read the same
canonical RunState projection.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path


_DOWNSTREAM_OF_DDD_INTEGRATION = frozenset(
    {"technical-decisions", "plan-writing", "implementation"}
)


def apply_procedure_stage_runtime_state_patch() -> None:
    """Install one-way CLI-to-RunState projection hooks after CLI initialization."""

    try:
        from harness_codex import cli
        from harness_codex.runtime import dashboard_runtime_state as dashboard
        from harness_codex.runtime import state as runtime_state
        from harness_codex.runtime.ddd_integration import verify_ddd_integration
        from harness_codex.runtime.models import RunMode, RunStatus
        from harness_codex.runtime.procedure_stages import (
            PROCEDURE_STAGES,
            parse_procedure_stage_rows,
            procedure_stage,
            stage_outputs_for_run,
            update_changeset_stage_status,
            verify_procedure_stage,
        )
    except ImportError:
        return

    required_cli_members = (
        "_record_procedure_stage_status",
        "_procedure_table_rows_for_change_set",
        "_format_already_verified_procedure_stage",
    )
    if not all(hasattr(cli, member) for member in required_cli_members):
        return
    if getattr(cli, "_procedure_stage_runtime_state_patch_applied", False):
        return

    original_runtime_projection = runtime_state.runtime_stage_projection
    original_assert_gate = dashboard.assert_canonical_stage_gate
    original_rows = cli._procedure_table_rows_for_change_set
    original_already_verified = cli._format_already_verified_procedure_stage

    def projected_stage_state(state):
        projection = original_runtime_projection(state)
        decisions = state.decision_results.get("procedure_stage_results", {})
        if not isinstance(decisions, dict):
            return projection
        for stage_id, record in decisions.items():
            if not isinstance(stage_id, str) or not isinstance(record, dict):
                continue
            status = record.get("status")
            if status not in {"verified", "blocked", "stale", "pending"}:
                continue
            artifact_row = projection.get(stage_id)
            if status == "pending" and artifact_row and artifact_row.get("status") in {
                "verified",
                "stale",
                "conflict",
            }:
                continue
            projection[stage_id] = {
                "id": stage_id,
                "status": status,
                "notes": str(record.get("notes") or "-"),
                "source": "run_state",
            }
        return projection

    runtime_state.runtime_stage_projection = projected_stage_state
    dashboard.runtime_stage_projection = projected_stage_state

    def record_canonical_stage(repo_root: Path, change_set_path: Path, stage, status: str, notes: str) -> None:
        change_set_id = change_set_path.stem
        current = dashboard.load_canonical_change_set_state(repo_root, change_set_id)
        absolute_change_set_path = repo_root / change_set_path
        if absolute_change_set_path.exists():
            affected_use_cases, affected_work_items = dashboard._affected_work_items(
                absolute_change_set_path
            )
        elif current is not None:
            affected_use_cases = current.affected_use_cases
            affected_work_items = current.affected_work_items
        else:
            affected_use_cases = ()
            affected_work_items = ()

        if current is None:
            current = runtime_state.RunState(
                run_id=dashboard.canonical_run_id(change_set_id),
                change_set_id=change_set_id,
                workflow_name="changeset-runtime-state",
                mode=RunMode.APPLY,
                affected_use_cases=affected_use_cases,
                affected_work_items=affected_work_items,
                status=RunStatus.PENDING,
            )

        artifacts = {item.stage: item for item in current.artifact_states}
        previous = artifacts.get(stage.stage_id)
        outputs = stage_outputs_for_run(stage, change_set_id=change_set_id)
        dirty_state = (
            runtime_state.ArtifactDirtyState.CLEAN
            if status == "verified"
            else runtime_state.ArtifactDirtyState.DIRTY
            if status == "stale"
            else runtime_state.ArtifactDirtyState.CONFLICT
        )
        artifacts[stage.stage_id] = runtime_state.StageArtifactState(
            stage=stage.stage_id,
            path=outputs[0] if outputs else change_set_path,
            revision=(previous.revision + 1) if previous else 1,
            generated_by="procedure-stage-cli",
            accepted=status == "verified",
            dirty_state=dirty_state,
            downstream_status=runtime_state.ArtifactDirtyState.CLEAN,
        )
        decisions = dict(current.decision_results)
        stage_results = dict(decisions.get("procedure_stage_results", {}))
        stage_results[stage.stage_id] = {"status": status, "notes": notes or "-"}
        decisions["procedure_stage_results"] = stage_results
        order = {item.stage_id: index for index, item in enumerate(PROCEDURE_STAGES)}
        updated = replace(
            current,
            affected_use_cases=affected_use_cases,
            affected_work_items=affected_work_items,
            decision_results=decisions,
            artifact_states=tuple(
                sorted(artifacts.values(), key=lambda item: (order.get(item.stage, len(order)), item.stage))
            ),
        )
        runtime_state.RunStateStore(repo_root).save(updated)
        dashboard.reconcile_change_set_procedure_table(repo_root, updated)

        # The table is not a gate source. This final write only guarantees that
        # a legacy reader sees the exact canonical projection immediately.
        if absolute_change_set_path.exists():
            projection = projected_stage_state(updated)[stage.stage_id]
            text = absolute_change_set_path.read_text(encoding="utf-8")
            mirrored = update_changeset_stage_status(
                text,
                stage=stage,
                status=projection["status"],
                notes=projection["notes"],
            )
            if mirrored != text:
                absolute_change_set_path.write_text(mirrored, encoding="utf-8")

    def record_stage_status(repo_root, change_set_path, stage, status, notes):
        record_canonical_stage(repo_root, change_set_path, stage, status, notes)

    cli._record_procedure_stage_status = record_stage_status

    def canonical_rows(repo_root, change_set_id):
        rows = original_rows(repo_root, change_set_id)
        state = dashboard.load_canonical_change_set_state(repo_root, change_set_id)
        if state is None:
            return rows
        projection = projected_stage_state(state)
        materialized = []
        seen = set()
        for row in rows:
            stage_id = row.get("id", "")
            runtime = projection.get(stage_id)
            materialized.append(
                {**row, **({"status": runtime["status"], "notes": runtime["notes"]} if runtime else {})}
            )
            seen.add(stage_id)
        for stage_id, runtime in projection.items():
            if stage_id not in seen:
                materialized.append(
                    {
                        "id": stage_id,
                        "procedure": stage_id,
                        "status": runtime["status"],
                        "verified_at": "-",
                        "notes": runtime["notes"],
                    }
                )
        return tuple(materialized)

    cli._procedure_table_rows_for_change_set = canonical_rows

    def already_verified(repo_root, change_set_path, stage, *, change_set_id, uc_id):
        state = dashboard.load_canonical_change_set_state(repo_root, change_set_id)
        if state is not None:
            runtime = projected_stage_state(state).get(stage.stage_id)
            if runtime and runtime["status"] == "verified":
                passed, _problems = verify_procedure_stage(
                    repo_root, stage, change_set_id=change_set_id, uc_id=uc_id
                )
                if passed:
                    return "\n".join(
                        (
                            f"Stage: {stage.stage_id}",
                            "Run: -",
                            "Interactive status: complete",
                            "Verification: passed",
                            "ChangeSet status: verified",
                            "Changed files: -",
                            "Session: -",
                            f"Notes: canonical RunState; {runtime['notes']}",
                        )
                    )
        return original_already_verified(
            repo_root, change_set_path, stage, change_set_id=change_set_id, uc_id=uc_id
        )

    cli._format_already_verified_procedure_stage = already_verified

    def assert_current_gate(repo_root, change_set_id, target_stage_id, *, uc_id=None):
        root = Path(repo_root)
        state = dashboard.load_canonical_change_set_state(root, change_set_id)
        if state is not None:
            _self_heal_verified_rows(root, change_set_id, target_stage_id, uc_id)
            state = dashboard.load_canonical_change_set_state(root, change_set_id)
        if state is not None and target_stage_id in _DOWNSTREAM_OF_DDD_INTEGRATION:
            integration = projected_stage_state(state).get("ddd-design-integration")
            if integration and integration["status"] == "verified":
                passed, problems = verify_ddd_integration(root, change_set_id=change_set_id)
                if not passed:
                    record_canonical_stage(
                        root,
                        Path("docs/changes/active") / f"{change_set_id}.md",
                        procedure_stage("ddd-design-integration"),
                        "stale",
                        "; ".join(problems),
                    )
        return original_assert_gate(root, change_set_id, target_stage_id, uc_id=uc_id)

    def _self_heal_verified_rows(repo_root: Path, change_set_id: str, target_stage_id: str, uc_id: str | None) -> None:
        change_path = repo_root / "docs/changes/active" / f"{change_set_id}.md"
        if not change_path.exists():
            return
        rows = {
            row.get("id", ""): row
            for row in parse_procedure_stage_rows(change_path.read_text(encoding="utf-8"))
        }
        stage_ids = [stage.stage_id for stage in PROCEDURE_STAGES]
        try:
            target_index = stage_ids.index(target_stage_id)
        except ValueError:
            return
        state = dashboard.load_canonical_change_set_state(repo_root, change_set_id)
        projection = projected_stage_state(state) if state is not None else {}
        for stage_id in stage_ids[:target_index]:
            runtime_status = projection.get(stage_id, {}).get("status")
            if runtime_status == "verified":
                continue
            if runtime_status != "blocked":
                continue
            row = rows.get(stage_id)
            if not row or row.get("status") != "verified":
                continue
            stage = procedure_stage(stage_id)
            if not _procedure_stage_outputs_are_current(repo_root, change_set_id, stage, uc_id):
                continue
            record_canonical_stage(
                repo_root,
                Path("docs/changes/active") / f"{change_set_id}.md",
                stage,
                "verified",
                row.get("notes") or "verified by current artifacts",
            )

    def _procedure_stage_outputs_are_current(repo_root: Path, change_set_id: str, stage, uc_id: str | None) -> bool:
        if stage.stage_id == "ddd-design-integration":
            passed, _problems = verify_ddd_integration(repo_root, change_set_id=change_set_id)
            return passed
        if stage.requires_uc:
            target_uc = (uc_id or "").strip()
            if not target_uc:
                return False
            passed, _problems = verify_procedure_stage(
                repo_root,
                stage,
                change_set_id=change_set_id,
                uc_id=target_uc,
            )
            return passed
        passed, _problems = verify_procedure_stage(
            repo_root,
            stage,
            change_set_id=change_set_id,
            uc_id=None,
        )
        return passed

    dashboard.assert_canonical_stage_gate = assert_current_gate
    cli._procedure_stage_runtime_state_patch_applied = True
