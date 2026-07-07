from pathlib import Path

import harness_codex.runtime.agent_trace_retention_patch as trace
from harness_codex.runtime.agent_trace_reference_cleanup_patch import (
    apply_agent_trace_reference_cleanup_patch,
)


def test_compaction_removes_run_root_log_references(tmp_path: Path) -> None:
    apply_agent_trace_reference_cleanup_patch()
    run_dir = tmp_path / ".harness" / "runs" / "run-001"
    step_dir = run_dir / "steps" / "ddd"
    step_dir.mkdir(parents=True)
    stdout = step_dir / "stdout.txt"
    stderr = step_dir / "stderr.txt"
    stdout.write_text("stdout", encoding="utf-8")
    stderr.write_text("stderr", encoding="utf-8")
    stdout_reference = run_dir / "stdout-ddd.log"
    stderr_reference = run_dir / "stderr-ddd.log"
    stdout_reference.write_text("See canonical artifact", encoding="utf-8")
    stderr_reference.write_text("See canonical artifact", encoding="utf-8")

    trace._remove_raw_logs(stdout, stderr)

    assert not stdout.exists()
    assert not stderr.exists()
    assert not stdout_reference.exists()
    assert not stderr_reference.exists()
