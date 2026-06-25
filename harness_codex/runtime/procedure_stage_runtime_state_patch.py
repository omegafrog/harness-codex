"""Route procedure-stage status and gates through canonical ChangeSet RunState.

The dashboard runtime state patch makes RunState authoritative for UI actions.  This
module brings direct CLI stage execution into the same model: the ChangeSet Markdown
table remains a derived display mirror and is never used as a separate gate source.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any


_DOWNSTREAM_OF_DDD_INTEGRATION = frozenset(
    {
        "technical-decisions",
        "design-visualization",
        "plan-writing",
        "implementation",
    }
)


def apply_procedure_stage_runtime_state_patch() -> None:
    """Install one-way RunState projection hooks when dashboard state exists."""

    try:
        from harness_codex import cli
        from harness_codex.runtime import dashboard_runtime_state as dashboard
        from harness_codex.runtime import state as runtime_state
        from harness_codex.runtime.ddd_integration import verify_ddd_integration
        from harness_codex.runtime.models import RunMode, RunStatus
        from harness_codex.runtime.procedure_stages import (
            PROCEDURE_STAGES,
            procedure_stage,
            stage_outputs_for_run,
            verify_procedure_stage,
        )
    except ImportError:
        # Older revisions without dashboard canonical state keep their existing
        # behavior. The patch becomes active when this PR is combined with main.
        return

    if getattr(cli, "_procedure_stage_runtime_state_patch_applied", False):
        return

    original_runtime_projection = runtime_state.runtime_stage_projection
    original_dashboard_artifacts = dashboard._dashboard_stage_artifacts
    original_assert_gate = dashboard.assert_canonical_stage_gate
    original_rows = cli._procedure_table_rows_for_change_set
    original_already_verified = cli._format_already_verified_procedure_stage
    original_stage_command = cli.procedure_stage_command

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
            projection[stage_id] = {
                "id": stage_id,
                "status": status,
                "notes": str(record.get("notes") or "-"),
                "source": "run_state",
            }
        return projection

    runtime_state.runtime_stage_projection = projected_stage_state
    dashboard.runtime_stage_projection = projected_stage_state

    def record_canonical_stage(
        repo_root: Path,
        change_set_path: Path,
        stage,
        status: str,
        notes: str,
    ) -> None:
        change_set_id = change_set_path.stem
        current = dashboard.load_canonical_change_set_state(repo_root, change_set_id)
        affected_use_cases, affected_work_items = dashboard._affected_work_items(
            repo_root / change_set_path
        )
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
        output_paths = stage_outputs_for_run(stage, change_set_id=change_set_id)
        artifact_path = output_paths[0] if output_paths else change_set_path
        dirty = (
            runtime_state.ArtifactDirtyState.CLEAN
            if status == "verified"
            else runtime_state.ArtifactDirtyState.DIRTY
            if status == "stale"
            else runtime_state.ArtifactDirtyState.CONFLICT
        )
        artifacts[stage.stage_id] = runtime_state.StageArtifactState(
            stage=stage.stage_id,
            path=artifact_path,
            checksum="",
            revision=(previous.revision + 1) if previous else 1,
            generated_by="procedure-stage-cli",
            accepted=status == "verified",
            dirty_state=dirty,
            downstream_status=runtime_state.ArtifactDirtyState.CLEAN,
        )
        decisions = dict(current.decision_results)
        stage_results = dict(decisions.get("procedure_stage_results", {}))
        stage_results[stage.stage_id] = {
            "status": status,
            "notes": notes or "-",
        }
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

    def record_stage_status(repo_root, change_set_path, stage, status, notes):
        # The Markdown procedure table is updated only by reconcile_change_set_procedure_table.
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
                {
                    **row,
                    **({"status": runtime["status"], "notes": runtime["notes"]} if runtime else {}),
                }
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
                    repo_root,
                    stage,
                    change_set_id=change_set_id,
                    uc_id=uc_id,
                )
                if passed:
                    return "\n".join(
                        [
                            f"Stage: {stage.stage_id}",
                            "Run: -",
                            "Interactive status: complete",
                            "Verification: passed",
                            "ChangeSet status: verified",
                            "Changed files: -",
                            "Session: -",
                            f"Notes: canonical RunState; {runtime['notes']}",
                        ]
                    )
        return original_already_verified(
            repo_root,
            change_set_path,
            stage,
            change_set_id=change_set_id,
            uc_id=uc_id,
        )

    cli._format_already_verified_procedure_stage = already_verified

    def candidate_only_dashboard_artifacts(root, session, affected_use_cases):
        artifacts = original_dashboard_artifacts(root, session, affected_use_cases)
        candidate_state = session.get("ddd_architecture")
        if not isinstance(candidate_state, dict) or not candidate_state.get("complete"):
            return artifacts
        uc_ids = tuple(str(item) for item in candidate_state.get("uc_ids", ()) if str(item))
        if uc_ids:
            dashboard._add_artifact(
                artifacts,
                "ddd-architecture-definition",
                root,
                [Path("docs/use-cases") / uc_id / "ddd-design.md" for uc_id in uc_ids],
            )
        return artifacts

    dashboard._dashboard_stage_artifacts = candidate_only_dashboard_artifacts

    def assert_current_gate(repo_root, change_set_id, target_stage_id):
        if target_stage_id in _DOWNSTREAM_OF_DDD_INTEGRATION:
            passed, problems = verify_ddd_integration(
                Path(repo_root),
                change_set_id=change_set_id,
            )
            if not passed:
                record_canonical_stage(
                    Path(repo_root),
                    Path("docs/changes/active") / f"{change_set_id}.md",
                    procedure_stage("ddd-design-integration"),
                    "stale",
                    "; ".join(problems),
                )
        return original_assert_gate(repo_root, change_set_id, target_stage_id)

    dashboard.assert_canonical_stage_gate = assert_current_gate

    def stage_command_with_canonical_gate(args, repo_root):
        stage_id = getattr(args, "procedure_stage_id", "")
        if stage_id in _DOWNSTREAM_OF_DDD_INTEGRATION and not getattr(args, "plan", False):
            change_set_id = str(getattr(args, "change_set_id", "") or "").strip()
            if change_set_id:
                assert_current_gate(repo_root, change_set_id, stage_id)
        return original_stage_command(args, repo_root)

    cli.procedure_stage_command = stage_command_with_canonical_gate
    cli._procedure_stage_runtime_state_patch_applied = True
