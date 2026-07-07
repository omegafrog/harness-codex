"""Remove run-root log references when accepted traces are compacted."""

from __future__ import annotations

from pathlib import Path


def apply_agent_trace_reference_cleanup_patch() -> None:
    """Keep compact trace metadata from pointing at deleted stdout/stderr files."""

    import harness_codex.runtime.agent_trace_retention_patch as trace

    original_remove = trace._remove_raw_logs
    if getattr(original_remove, "_trace_reference_cleanup_patch", False):
        return

    def remove_raw_logs(stdout_path: Path, stderr_path: Path) -> None:
        step_dir = stdout_path.parent
        run_dir = step_dir.parent.parent
        step_id = step_dir.name
        paths = (
            stdout_path,
            stderr_path,
            run_dir / f"stdout-{step_id}.log",
            run_dir / f"stderr-{step_id}.log",
        )
        for path in paths:
            try:
                path.unlink()
            except FileNotFoundError:
                continue
            except OSError:
                continue

    remove_raw_logs._trace_reference_cleanup_patch = True
    trace._remove_raw_logs = remove_raw_logs
