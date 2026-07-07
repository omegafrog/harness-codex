import json
from pathlib import Path

from harness_codex.runtime.agent_trace_retention_patch import (
    _artifact_summary,
    _compact_checkpoint,
    _remove_raw_logs,
)


def test_success_trace_summary_keeps_only_stderr_tail(tmp_path: Path) -> None:
    stdout = tmp_path / "stdout.txt"
    stderr = tmp_path / "stderr.txt"
    stdout.write_text("event\n" * 10, encoding="utf-8")
    stderr.write_text("warning\n" * 10, encoding="utf-8")

    stdout_summary = _artifact_summary(stdout)
    stderr_summary = _artifact_summary(stderr, include_tail=True)

    assert stdout_summary == {"present": True, "bytes": stdout.stat().st_size}
    assert stderr_summary["bytes"] == stderr.stat().st_size
    assert stderr_summary["tail"].endswith("warning")


def test_compact_checkpoint_drops_deleted_stdout_evidence(tmp_path: Path) -> None:
    checkpoint = tmp_path / "checkpoint.json"
    checkpoint.write_text(
        json.dumps(
            {
                "evidence_paths": [
                    ".harness/runs/run/steps/execute/stdout.txt",
                    ".harness/runs/run/steps/execute/final-message.md",
                ]
            }
        ),
        encoding="utf-8",
    )

    _compact_checkpoint(checkpoint)

    payload = json.loads(checkpoint.read_text(encoding="utf-8"))
    assert payload["trace_retention"] == "summary"
    assert payload["evidence_paths"] == [".harness/runs/run/steps/execute/final-message.md"]


def test_remove_raw_logs_deletes_success_stream_files(tmp_path: Path) -> None:
    stdout = tmp_path / "stdout.txt"
    stderr = tmp_path / "stderr.txt"
    stdout.write_text("stdout", encoding="utf-8")
    stderr.write_text("stderr", encoding="utf-8")

    _remove_raw_logs(stdout, stderr)

    assert not stdout.exists()
    assert not stderr.exists()
