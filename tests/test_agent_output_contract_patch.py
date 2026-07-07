import json
from pathlib import Path
from types import SimpleNamespace

from harness_codex.runtime.agent_output_contract_patch import (
    _persist_output_contract_failure,
    _validate_declared_output_shapes,
)
from harness_codex.runtime.models import FailureKind, StepResult, StepStatus


class _Runner:
    @staticmethod
    def _write_response_snapshot(context, step_id: str, result_path: Path) -> None:
        target = context.run_dir / f"response-{step_id}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(result_path.read_bytes())


def _step(*outputs: str):
    return SimpleNamespace(id="review", agent_id="artifact_reviewer", outputs=tuple(Path(path) for path in outputs))


def test_rejects_empty_declared_markdown_output(tmp_path: Path) -> None:
    output = tmp_path / "docs" / "candidate.md"
    output.parent.mkdir(parents=True)
    output.write_text("", encoding="utf-8")

    assert _validate_declared_output_shapes(_step("docs/candidate.md"), tmp_path) == "agent output must not be empty: docs/candidate.md"


def test_rejects_directory_for_declared_file_output(tmp_path: Path) -> None:
    (tmp_path / "docs" / "candidate.md").mkdir(parents=True)

    assert _validate_declared_output_shapes(_step("docs/candidate.md"), tmp_path) == "agent output must be a regular file: docs/candidate.md"


def test_accepts_nonempty_declared_directory_output(tmp_path: Path) -> None:
    (tmp_path / "docs" / "use-cases").mkdir(parents=True)

    assert _validate_declared_output_shapes(_step("docs/use-cases"), tmp_path) is None


def test_persists_final_output_contract_failure(tmp_path: Path) -> None:
    run_dir = tmp_path / ".harness" / "runs" / "run-001"
    step_dir = run_dir / "steps" / "review"
    step_dir.mkdir(parents=True)
    (step_dir / "result.json").write_text(
        json.dumps({"step_id": "review", "status": "succeeded", "metadata": {}}),
        encoding="utf-8",
    )
    context = SimpleNamespace(run_dir=run_dir)
    result = StepResult(
        step_id="review",
        status=StepStatus.FAILED,
        error="agent output must not be empty: docs/review.md",
        failure_kind=FailureKind.IMPLEMENTATION,
        metadata={"output_contract_status": "failed"},
    )

    _persist_output_contract_failure(_Runner, context, _step("docs/review.md"), step_dir, result)

    payload = json.loads((step_dir / "result.json").read_text(encoding="utf-8"))
    assert payload["status"] == "failed"
    assert payload["metadata"]["output_contract_status"] == "failed"
    assert (run_dir / "response-review.json").is_file()
