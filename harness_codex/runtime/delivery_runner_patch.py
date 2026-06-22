"""Runner integration for explicitly approved, resumable delivery commands."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


_APPROVED_VALUES = {"1", "true", "yes"}


def apply_delivery_runner_patch() -> None:
    """Teach command-backed delivery steps to honor ``approval_env`` metadata.

    The generic runner intentionally remains unchanged for ordinary commands.  Only a
    workflow step declaring ``metadata.approval_env`` receives this behavior: missing
    consent returns a blocked, environment-classified result; approved runs receive a
    sanitized affirmative value in the child process environment; and a delivery
    command's documented ``BLOCKED:`` / exit-code-2 result remains resumable.
    """

    from harness_codex.runtime.models import FailureKind, StepResult, StepStatus
    from harness_codex.runtime.runner import BasicStepRunner, _relative_to_repo

    if getattr(BasicStepRunner, "_delivery_approval_patch_applied", False):
        return

    original = BasicStepRunner._run_command

    def run_command(self, step, context, step_dir: Path):
        approval_env = str(step.metadata.get("approval_env", "")).strip()
        if not approval_env:
            return original(self, step, context, step_dir)

        requested = context.metadata.get("delivery_approved")
        candidate = requested if requested is not None else os.environ.get(approval_env, "")
        approved = str(candidate).strip().lower() in _APPROVED_VALUES
        result_path = step_dir / "result.txt"
        if not approved:
            message = (
                "explicit delivery approval is required; "
                f"set {approval_env}=1 or pass delivery_approved in the run context"
            )
            (step_dir / "stdout.txt").write_text("", encoding="utf-8")
            (step_dir / "stderr.txt").write_text(f"BLOCKED: {message}\n", encoding="utf-8")
            result_path.write_text("exit_code=2\n", encoding="utf-8")
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                exit_code=2,
                output_path=_relative_to_repo(result_path, context),
                error=message,
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                metadata={"approval_env": approval_env, "delivery_approved": False},
            )

        command = step.command
        if not command:
            return StepResult(step_id=step.id, status=StepStatus.BLOCKED, error="command is required")
        if step.id == "verify-work-item" and context.metadata.get("force_verification"):
            command = f"{command} --force-verification"
        env = {**os.environ, approval_env: "1"}
        completed = subprocess.run(
            command,
            cwd=context.workdir,
            shell=True,
            text=True,
            capture_output=True,
            timeout=step.timeout_sec,
            check=False,
            env=env,
        )
        (step_dir / "stdout.txt").write_text(completed.stdout, encoding="utf-8")
        (step_dir / "stderr.txt").write_text(completed.stderr, encoding="utf-8")
        result_path.write_text(f"exit_code={completed.returncode}\n", encoding="utf-8")
        error = completed.stderr.strip() or completed.stdout.strip()
        is_delivery_blocked = completed.returncode == 2 and "BLOCKED:" in error
        if is_delivery_blocked:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                exit_code=completed.returncode,
                output_path=_relative_to_repo(result_path, context),
                error=error.removeprefix("BLOCKED:").strip(),
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                metadata={"approval_env": approval_env, "delivery_approved": True},
            )
        if completed.returncode != 0:
            return StepResult(
                step_id=step.id,
                status=StepStatus.FAILED,
                exit_code=completed.returncode,
                output_path=_relative_to_repo(result_path, context),
                error=error,
                failure_kind=FailureKind.IMPLEMENTATION,
                metadata={"approval_env": approval_env, "delivery_approved": True},
            )
        return StepResult(
            step_id=step.id,
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            output_path=_relative_to_repo(result_path, context),
            metadata={"approval_env": approval_env, "delivery_approved": True},
        )

    BasicStepRunner._run_command = run_command
    BasicStepRunner._delivery_approval_patch_applied = True
