"""Step runner boundary for runtime execution.

`StepRunner` is the adapter boundary between the pure runtime engine and
side-effecting implementations such as Codex, shell, git, and validators.
"""

from __future__ import annotations

import shutil
import subprocess
from typing import Protocol
from pathlib import Path

from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    Step,
    StepKind,
    StepResult,
    StepStatus,
)


class StepRunner(Protocol):
    """Adapter interface used by `RunnerEngine` to execute one step.

    Implementations may call Codex, shell, git, validators, or fake test doubles.

    The engine depends only on this protocol and never performs those side
    effects directly.
    """

    def run(self, step: Step, context: RunContext) -> StepResult:
        """Execute one step and return a structured result."""
        ...


class BasicStepRunner:
    """Local MVP adapter for record/shell/validator/git steps."""

    def run(self, step: Step, context: RunContext) -> StepResult:
        step_dir = context.run_dir / "steps" / step.id
        step_dir.mkdir(parents=True, exist_ok=True)

        if step.kind == StepKind.RECORD:
            return self._run_record(step, context, step_dir)
        if step.kind in {StepKind.SHELL, StepKind.VALIDATOR}:
            return self._run_command(step, context, step_dir)
        if step.kind == StepKind.GIT:
            return self._run_git_boundary(step, context, step_dir)
        if step.kind == StepKind.AGENT:
            blocker_path = step_dir / "blocker.txt"
            blocker_path.write_text(
                "AGENT step is a pluggable boundary in the MVP runtime\n",
                encoding="utf-8",
            )
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error="AGENT step is a pluggable boundary in the MVP runtime",
                output_path=_relative_to_repo(blocker_path, context),
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
            )

        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)

    def _run_record(
        self,
        step: Step,
        context: RunContext,
        step_dir: Path,
    ) -> StepResult:
        missing = tuple(
            path for path in step.inputs if not (context.repo_root / path).exists()
        )
        evidence = step_dir / "record.json"
        evidence.write_text(
            "{\n"
            f'  "step_id": "{step.id}",\n'
            f'  "missing_inputs": {[str(path) for path in missing]}\n'
            "}\n",
            encoding="utf-8",
        )
        if missing:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                output_path=_relative_to_repo(evidence, context),
                error="missing inputs: " + ", ".join(str(path) for path in missing),
            )
        for output in step.outputs:
            (context.repo_root / output).parent.mkdir(parents=True, exist_ok=True)
        return StepResult(
            step_id=step.id,
            status=StepStatus.SUCCEEDED,
            output_path=_relative_to_repo(evidence, context),
        )

    def _run_command(
        self,
        step: Step,
        context: RunContext,
        step_dir: Path,
    ) -> StepResult:
        if not step.command:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error="command is required",
            )

        completed = subprocess.run(
            step.command,
            cwd=context.workdir,
            shell=True,
            text=True,
            capture_output=True,
            timeout=step.timeout_sec,
            check=False,
        )
        (step_dir / "stdout.txt").write_text(completed.stdout, encoding="utf-8")
        (step_dir / "stderr.txt").write_text(completed.stderr, encoding="utf-8")
        result_path = step_dir / "result.txt"
        result_path.write_text(
            f"exit_code={completed.returncode}\n",
            encoding="utf-8",
        )
        if completed.returncode != 0:
            return StepResult(
                step_id=step.id,
                status=StepStatus.FAILED,
                exit_code=completed.returncode,
                output_path=_relative_to_repo(result_path, context),
                error=completed.stderr.strip() or completed.stdout.strip(),
                failure_kind=FailureKind.IMPLEMENTATION,
            )
        return StepResult(
            step_id=step.id,
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            output_path=_relative_to_repo(result_path, context),
        )

    def _run_git_boundary(
        self,
        step: Step,
        context: RunContext,
        step_dir: Path,
    ) -> StepResult:
        if step.command:
            return self._run_command(step, context, step_dir)

        if len(step.inputs) == 1 and len(step.outputs) == 1:
            source = context.repo_root / step.inputs[0]
            target = context.repo_root / step.outputs[0]
            if not source.exists():
                return StepResult(
                    step_id=step.id,
                    status=StepStatus.BLOCKED,
                    error=f"missing source: {step.inputs[0]}",
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), str(target))
            return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)

        return StepResult(
            step_id=step.id,
            status=StepStatus.BLOCKED,
            error="git step requires an explicit command or one input/output move",
        )


def _relative_to_repo(path: Path, context: RunContext) -> Path:
    try:
        return path.relative_to(context.repo_root)
    except ValueError:
        return path
