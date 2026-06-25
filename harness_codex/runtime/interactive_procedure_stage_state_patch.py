"""Ensure interactive procedure outcomes are recorded through canonical RunState."""

from __future__ import annotations


def apply_interactive_procedure_stage_state_patch() -> None:
    """Wrap the legacy interactive completion path after CLI initialization."""

    try:
        from harness_codex import cli
    except ImportError:
        return

    if not hasattr(cli, "_run_interactive_procedure_stage"):
        return
    if getattr(cli, "_interactive_procedure_stage_state_patch_applied", False):
        return

    original = cli._run_interactive_procedure_stage

    def run_interactive_with_canonical_record(args, repo_root, stage, uc_id, change_set_path):
        result = original(args, repo_root, stage, uc_id, change_set_path)
        status = _line_value(result, "ChangeSet status:")
        notes = _line_value(result, "Notes:")
        if status in {"verified", "blocked", "stale", "pending"}:
            cli._record_procedure_stage_status(
                repo_root,
                change_set_path,
                stage,
                status,
                notes or "interactive stage result",
            )
        return result

    cli._run_interactive_procedure_stage = run_interactive_with_canonical_record
    cli._interactive_procedure_stage_state_patch_applied = True


def _line_value(text: str, prefix: str) -> str:
    for line in text.splitlines():
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return ""
