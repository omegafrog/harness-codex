from pathlib import Path

from harness_codex.runtime.engine import RunnerEngine
from harness_codex.runtime.models import (
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepResult,
    StepStatus,
    Workflow,
)


class _FakeRunner:
    def run(self, step: Step, context: RunContext) -> StepResult:
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def _context(tmp_path: Path) -> RunContext:
    return RunContext(
        run_id="run-test",
        workflow_name="test-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-test",
    )


def test_runner_engine_emits_feedback_after_each_step(tmp_path: Path) -> None:
    messages: list[str] = []
    workflow = Workflow(
        name="test-workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(id="first", kind=StepKind.RECORD, name="첫 단계"),
            Step(id="second", kind=StepKind.RECORD, name="둘째 단계", needs=("first",)),
        ),
    )

    result = RunnerEngine(_FakeRunner(), progress_emit=messages.append).run(
        workflow,
        _context(tmp_path),
    )

    assert result.status.value == "succeeded"
    assert messages == ["first: succeeded", "second: succeeded"]


def test_runner_engine_emits_feedback_for_policy_block(tmp_path: Path) -> None:
    messages: list[str] = []
    workflow = Workflow(
        name="test-workflow",
        mode=RunMode.APPLY,
        steps=(
            Step(
                id="push",
                kind=StepKind.SHELL,
                name="push",
                command="git push origin HEAD",
            ),
        ),
    )

    result = RunnerEngine(_FakeRunner(), progress_emit=messages.append).run(
        workflow,
        _context(tmp_path),
    )

    assert result.status.value == "blocked"
    assert messages
    assert messages[0].startswith("push: blocked - ")
