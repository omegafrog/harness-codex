import json
from pathlib import Path

from harness_codex.runtime.agent_trace_retention_patch import (
    _accepted_contract,
    _artifact_summary,
    _compact_accepted_agent_trace,
    _compact_checkpoint,
    _provider_usage,
    _remove_raw_logs,
)
from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepResult, StepStatus


class _Runner:
    @staticmethod
    def _relative_to_repo(path: Path, context: RunContext) -> Path:
        return path.relative_to(context.repo_root)

    @staticmethod
    def _write_response_snapshot(context: RunContext, step_id: str, result_path: Path) -> None:
        target = context.run_dir / f"response-{step_id}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(result_path.read_bytes())


def _context(tmp_path: Path) -> RunContext:
    run_dir = tmp_path / ".harness" / "runs" / "run-001"
    return RunContext(
        run_id="run-001",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=run_dir,
    )


def _step() -> Step:
    return Step(
        id="ddd",
        kind=StepKind.AGENT,
        name="DDD",
        agent_id="ddd_architect",
        outputs=(Path("docs/use-cases/UC-001/ddd-design.md"),),
    )


def _accepted_result_files(tmp_path: Path) -> tuple[RunContext, Step, Path, StepResult]:
    context = _context(tmp_path)
    step = _step()
    step_dir = context.run_dir / "steps" / step.id
    step_dir.mkdir(parents=True)
    output = context.repo_root / step.outputs[0]
    output.parent.mkdir(parents=True)
    output.write_text("# candidate\n", encoding="utf-8")
    (step_dir / "final-message.md").write_text('{"status":"complete"}', encoding="utf-8")
    (step_dir / "stdout.txt").write_text('{"usage":{"input_tokens":10,"output_tokens":5,"reasoning_tokens":2}}\n', encoding="utf-8")
    (step_dir / "stderr.txt").write_text("warning\n", encoding="utf-8")
    (step_dir / "result.json").write_text(
        json.dumps({"step_id": step.id, "status": "succeeded", "metadata": {}}),
        encoding="utf-8",
    )
    return context, step, step_dir, StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def test_trace_contract_requires_final_message_and_accepted_result(tmp_path: Path) -> None:
    context = _context(tmp_path)
    step = _step()
    step_dir = context.run_dir / "steps" / step.id
    step_dir.mkdir(parents=True)
    output = context.repo_root / step.outputs[0]
    output.parent.mkdir(parents=True)
    output.write_text("# candidate\n", encoding="utf-8")
    (step_dir / "result.json").write_text(
        json.dumps({"step_id": step.id, "status": "succeeded", "metadata": {}}),
        encoding="utf-8",
    )
    result = StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)

    assert _accepted_contract(step, context, step_dir / "result.json", step_dir / "final-message.md", result) is None

    (step_dir / "final-message.md").write_text('{"status":"complete"}', encoding="utf-8")
    contract = _accepted_contract(step, context, step_dir / "result.json", step_dir / "final-message.md", result)

    assert contract is not None
    assert contract["result_status"] == "succeeded"
    assert contract["declared_outputs"][0]["path"] == str(step.outputs[0])


def test_trace_contract_keeps_external_final_message_path(tmp_path: Path) -> None:
    context = _context(tmp_path / "repo")
    step = _step()
    external_step_dir = tmp_path / ".-harness-worktrees" / "CHG-001" / "UC-001" / "steps" / step.id
    external_step_dir.mkdir(parents=True)
    output = context.repo_root / step.outputs[0]
    output.parent.mkdir(parents=True)
    output.write_text("# candidate\n", encoding="utf-8")
    final_message = external_step_dir / "final-message.md"
    final_message.write_text("done", encoding="utf-8")
    result_path = external_step_dir / "result.json"
    result_path.write_text(
        json.dumps({"step_id": step.id, "status": "succeeded", "metadata": {}}),
        encoding="utf-8",
    )

    contract = _accepted_contract(
        step,
        context,
        result_path,
        final_message,
        StepResult(step_id=step.id, status=StepStatus.SUCCEEDED),
    )

    assert contract is not None
    assert contract["final_message_path"] == str(final_message)


def test_trace_contract_rejects_failed_or_missing_output(tmp_path: Path) -> None:
    context = _context(tmp_path)
    step = _step()
    step_dir = context.run_dir / "steps" / step.id
    step_dir.mkdir(parents=True)
    (step_dir / "final-message.md").write_text("done", encoding="utf-8")
    (step_dir / "result.json").write_text(
        json.dumps({"step_id": step.id, "status": "succeeded"}),
        encoding="utf-8",
    )

    assert _accepted_contract(
        step,
        context,
        step_dir / "result.json",
        step_dir / "final-message.md",
        StepResult(step_id=step.id, status=StepStatus.FAILED),
    ) is None
    assert _accepted_contract(
        step,
        context,
        step_dir / "result.json",
        step_dir / "final-message.md",
        StepResult(step_id=step.id, status=StepStatus.SUCCEEDED),
    ) is None


def test_compaction_requires_accepted_contract_then_removes_raw_logs(tmp_path: Path) -> None:
    context, step, step_dir, result = _accepted_result_files(tmp_path)

    metadata = _compact_accepted_agent_trace(
        runner=_Runner,
        step=step,
        context=context,
        step_dir=step_dir,
        result=result,
    )

    assert metadata is not None
    assert metadata["trace_contract_status"] == "accepted"
    assert not (step_dir / "stdout.txt").exists()
    assert not (step_dir / "stderr.txt").exists()
    persisted = json.loads((step_dir / "result.json").read_text(encoding="utf-8"))
    assert persisted["metadata"]["trace_retention"] == "summary"
    assert persisted["metadata"]["usage"]["input_tokens"] == 10
    assert (step_dir / "trace-summary.json").is_file()


def test_trace_summary_includes_hash_and_stderr_tail(tmp_path: Path) -> None:
    stdout = tmp_path / "stdout.txt"
    stderr = tmp_path / "stderr.txt"
    stdout.write_text("event\n" * 10, encoding="utf-8")
    stderr.write_text("warning\n" * 10, encoding="utf-8")

    stdout_summary = _artifact_summary(stdout)
    stderr_summary = _artifact_summary(stderr, include_tail=True)

    assert stdout_summary["bytes"] == stdout.stat().st_size
    assert len(stdout_summary["sha256"]) == 64
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
