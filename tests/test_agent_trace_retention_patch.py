import json
from pathlib import Path
from types import SimpleNamespace

from harness_codex.runtime.agent_trace_retention_patch import (
    _artifact_summary,
    _compact_checkpoint,
    _provider_usage,
    _remove_raw_logs,
    _write_success_response,
)
from harness_codex.runtime.models import StepStatus


class _Runner:
    @staticmethod
    def _relative_to_repo(path: Path, context) -> Path:
        return path.relative_to(context.repo_root)


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


def test_compact_trace_keeps_provider_usage_before_stdout_delete(tmp_path: Path) -> None:
    stdout = tmp_path / "stdout.txt"
    stdout.write_text(
        json.dumps(
            {
                "usage": {
                    "input_tokens": 120,
                    "cached_input_tokens": 20,
                    "output_tokens": 30,
                    "reasoning_tokens": 40,
                }
            }
        )
        + "\n",
        encoding="utf-8",
    )

    assert _provider_usage(stdout) == {
        "input_tokens": 120,
        "prompt_tokens": 120,
        "cached_input_tokens": 20,
        "cached_prompt_tokens": 20,
        "output_tokens": 30,
        "completion_tokens": 30,
        "reasoning_tokens": 40,
        "total_tokens": 190,
    }


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


def test_success_response_points_to_final_message_without_copying_it(tmp_path: Path) -> None:
    run_dir = tmp_path / ".harness" / "runs" / "run-001"
    step_dir = run_dir / "steps" / "ddd"
    step_dir.mkdir(parents=True)
    final_message = step_dir / "final-message.md"
    final_message.write_text('{"status":"complete"}', encoding="utf-8")
    context = SimpleNamespace(repo_root=tmp_path, run_dir=run_dir)
    request = SimpleNamespace(context=context, step=SimpleNamespace(id="ddd"))
    result = SimpleNamespace(
        status=StepStatus.SUCCEEDED,
        exit_code=0,
        error=None,
        metadata={"trace_retention": "summary"},
    )

    _write_success_response(
        _Runner,
        request,
        final_message,
        result,
        {"retention": "summary"},
    )

    response = json.loads((run_dir / "response-ddd.json").read_text(encoding="utf-8"))
    assert response["final_message_path"].endswith("final-message.md")
    assert "final_message" not in response
