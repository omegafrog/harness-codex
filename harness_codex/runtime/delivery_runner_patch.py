"""승인된 전달 명령과 레거시 완료 경계의 실행기 통합."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


_APPROVED_VALUES = {"1", "true", "yes"}


def apply_delivery_runner_patch() -> None:
    """전달 단계의 승인·차단·재개 규칙을 실행기에 연결한다."""

    from harness_codex.runtime.changes.parser import parse_changeset_markdown
    from harness_codex.runtime.completion import (
        ChangeSetCompletionBlocked,
        complete_change_set_if_ready,
    )
    from harness_codex.runtime.models import FailureKind, StepResult, StepStatus
    import harness_codex.runtime.runner as runner_module

    BasicStepRunner = runner_module.BasicStepRunner
    relative_to_repo = runner_module._relative_to_repo
    if getattr(BasicStepRunner, "_delivery_approval_patch_applied", False):
        return

    original_command = BasicStepRunner._run_command

    def run_command(self, step, context, step_dir: Path):
        approval_env = str(step.metadata.get("approval_env", "")).strip()
        if not approval_env:
            return original_command(self, step, context, step_dir)

        requested = context.metadata.get("delivery_approved")
        candidate = requested if requested is not None else os.environ.get(approval_env, "")
        approved = str(candidate).strip().lower() in _APPROVED_VALUES
        result_path = step_dir / "result.txt"
        if not approved:
            message = (
                "명시적인 전달 승인이 필요합니다. "
                f"{approval_env}=1 또는 RunContext.delivery_approved를 설정하세요."
            )
            (step_dir / "stdout.txt").write_text("", encoding="utf-8")
            (step_dir / "stderr.txt").write_text(
                f"BLOCKED: {message}\n",
                encoding="utf-8",
            )
            result_path.write_text("exit_code=2\n", encoding="utf-8")
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                exit_code=2,
                output_path=relative_to_repo(result_path, context),
                error=message,
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                metadata={"approval_env": approval_env, "delivery_approved": False},
            )

        command = step.command
        if not command:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error="command is required",
            )
        if step.id == "verify-work-item" and context.metadata.get("force_verification"):
            command = f"{command} --force-verification"
        completed = subprocess.run(
            command,
            cwd=context.workdir,
            shell=True,
            text=True,
            capture_output=True,
            timeout=step.timeout_sec,
            check=False,
            env={**os.environ, approval_env: "1"},
        )
        (step_dir / "stdout.txt").write_text(completed.stdout, encoding="utf-8")
        (step_dir / "stderr.txt").write_text(completed.stderr, encoding="utf-8")
        result_path.write_text(f"exit_code={completed.returncode}\n", encoding="utf-8")
        error = completed.stderr.strip() or completed.stdout.strip()
        if completed.returncode == 2 and "BLOCKED:" in error:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                exit_code=completed.returncode,
                output_path=relative_to_repo(result_path, context),
                error=error.removeprefix("BLOCKED:").strip(),
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                metadata={"approval_env": approval_env, "delivery_approved": True},
            )
        if completed.returncode != 0:
            return StepResult(
                step_id=step.id,
                status=StepStatus.FAILED,
                exit_code=completed.returncode,
                output_path=relative_to_repo(result_path, context),
                error=error,
                failure_kind=FailureKind.IMPLEMENTATION,
                metadata={"approval_env": approval_env, "delivery_approved": True},
            )
        return StepResult(
            step_id=step.id,
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            output_path=relative_to_repo(result_path, context),
            metadata={"approval_env": approval_env, "delivery_approved": True},
        )

    def complete_change_set_boundary(step, context):
        """Keep the legacy move-only boundary side-effect free.

        Canonical workflows use the explicit completion-delivery command.  The legacy
        boundary therefore only validates and archives the ChangeSet; it never calls
        `git add -A`, commits, or pushes unrelated worktree state.
        """

        change_set_path = context.repo_root / step.inputs[0]
        if not change_set_path.exists():
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error=f"missing source: {step.inputs[0]}",
            )
        change_set = parse_changeset_markdown(
            change_set_path.read_text(encoding="utf-8"),
            path=step.inputs[0],
        )
        try:
            completion = complete_change_set_if_ready(
                context.repo_root,
                change_set,
                run_id=context.run_id,
            )
        except ChangeSetCompletionBlocked as exc:
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                error=f"ChangeSet completion blocked: {exc.reason}",
            )
        return StepResult(
            step_id=step.id,
            status=StepStatus.SUCCEEDED,
            output_path=completion.report_path,
            metadata={
                "completed_path": str(completion.completed_path),
                "completed_work_items": list(completion.completed_work_items),
                "already_completed": completion.already_completed,
                "completion_published": False,
            },
        )

    BasicStepRunner._run_command = run_command
    BasicStepRunner._delivery_approval_patch_applied = True
    runner_module._complete_change_set_boundary = complete_change_set_boundary

    from harness_codex.runtime.agent_write_scope_policy_patch import (
        apply_agent_write_scope_policy_patch,
    )

    apply_agent_write_scope_policy_patch()
