"""Keep DDD integration reruns executable and canonically visible in the dashboard."""

from __future__ import annotations

from pathlib import Path


_DDD_INTEGRATION_STAGE_ID = "ddd-design-integration"
_PATCHED_ATTR = "_harness_ddd_integration_rerun_patch_applied"


def apply_dashboard_ddd_integration_rerun_patch() -> None:
    """Add the explicit apply mode and canonical failure projection for integration reruns."""

    from harness_codex.runtime import ui_server

    if getattr(ui_server, _PATCHED_ATTR, False):
        return

    original_command = ui_server._rerun_design_stage_command
    original_run_job = ui_server._run_rerun_design_stage_job

    def command_with_ddd_integration_apply(
        root: Path,
        change_set_id: str,
        stage_id: str,
        user_prompt: str,
        *,
        uc_id: str,
    ) -> list[str]:
        command = original_command(
            root,
            change_set_id,
            stage_id,
            user_prompt,
            uc_id=uc_id,
        )
        if stage_id == _DDD_INTEGRATION_STAGE_ID and "--apply" not in command:
            command.append("--apply")
        return command

    def run_job_with_canonical_failure(
        root: Path,
        change_set_id: str,
        stage_id: str,
        user_prompt: str,
        uc_id: str,
        answers: list[dict[str, str]],
        restart: bool,
    ) -> None:
        original_run_job(
            root,
            change_set_id,
            stage_id,
            user_prompt,
            uc_id,
            answers,
            restart,
        )
        if stage_id != _DDD_INTEGRATION_STAGE_ID:
            return

        with ui_server._STAGE_RERUN_JOBS_LOCK:
            job = ui_server._STAGE_RERUN_JOBS.get(change_set_id)
            failed = bool(job and job.get("status") == "failed")
            detail = str(job.get("error") or "stage rerun failed") if job else "stage rerun failed"
        if not failed:
            return

        _record_failed_integration_stage(root, change_set_id, detail)
        dashboard = ui_server.document_dashboard_state(root)
        with ui_server._STAGE_RERUN_JOBS_LOCK:
            current = ui_server._STAGE_RERUN_JOBS.get(change_set_id)
            if current is not None:
                current["dashboard"] = dashboard

    ui_server._rerun_design_stage_command = command_with_ddd_integration_apply
    ui_server._run_rerun_design_stage_job = run_job_with_canonical_failure
    setattr(ui_server, _PATCHED_ATTR, True)


def _record_failed_integration_stage(root: Path, change_set_id: str, detail: str) -> None:
    """Make an asynchronous rerun failure visible through the canonical stage state."""

    change_set_path = root / "docs/changes/active" / f"{change_set_id}.md"
    if not change_set_path.exists():
        return

    from harness_codex import cli

    cli._record_procedure_stage_status(
        root,
        change_set_path.relative_to(root),
        _integration_stage(),
        "blocked",
        f"DDD Design Integration rerun failed: {detail}",
    )


def _integration_stage():
    """Resolve the stage lazily after the canonical CLI bridge is installed."""

    from harness_codex.runtime.procedure_stages import procedure_stage

    return procedure_stage(_DDD_INTEGRATION_STAGE_ID)
