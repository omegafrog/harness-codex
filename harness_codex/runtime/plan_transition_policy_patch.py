"""Enforce work-item plan location and executor-owned plan updates."""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass, replace
from pathlib import Path


_PLAN_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
_CHECKBOX_RE = re.compile(r"^(\s*[-*+]\s*)\[[ xX]\]", flags=re.MULTILINE)
_GUARDED_AGENT_STEPS = frozenset(
    {
        "plan-work-item",
        "secure-work-item-plan",
        "review-work-item-plan",
        "execute-work-item",
        "review-work-item-security",
    }
)


@dataclass(frozen=True)
class _PlanLocationSnapshot:
    active_path: Path
    completed_path: Path
    active_exists: bool
    completed_exists: bool
    active_content: bytes | None
    completed_content: bytes | None


def apply_plan_transition_policy_patch() -> None:
    """Install the non-completion plan-location boundary around agent steps."""

    from harness_codex.runtime.models import FailureKind, StepStatus
    import harness_codex.runtime.runner as runner_module

    basic_step_runner = runner_module.BasicStepRunner
    if getattr(basic_step_runner, "_plan_transition_policy_patch_applied", False):
        return

    original_run_agent = basic_step_runner._run_agent

    def run_agent(self, step, context, step_dir: Path):
        if step.id not in _GUARDED_AGENT_STEPS:
            return original_run_agent(self, step, context, step_dir)

        active_path = _active_plan_path(step, context)
        if active_path is None:
            return original_run_agent(self, step, context, step_dir)
        completed_path = _completed_plan_path(active_path)

        recovery_error = _recover_plan_for_retry(active_path, completed_path)
        if recovery_error is not None:
            return _blocked_transition_result(
                runner_module,
                step,
                context,
                step_dir,
                recovery_error,
                FailureKind,
            )

        before = _capture_plan_location(active_path, completed_path)
        result = original_run_agent(self, step, context, step_dir)
        after = _capture_plan_location(active_path, completed_path)
        transition_error = _plan_transition_error(step, before, after)
        if transition_error is None:
            return result

        _restore_plan_location(before)
        evidence = _write_transition_evidence(
            step_dir,
            step_id=step.id,
            active_path=active_path,
            completed_path=completed_path,
            error=transition_error,
        )
        metadata = {
            **dict(result.metadata),
            "plan_transition_status": "blocked",
            "plan_transition_evidence": str(_relative_to_repo(evidence, context)),
        }
        _rewrite_result_artifact(
            runner_module,
            step,
            context,
            step_dir,
            status=StepStatus.BLOCKED,
            error=transition_error,
            metadata=metadata,
        )
        return replace(
            result,
            status=StepStatus.BLOCKED,
            error=transition_error,
            failure_kind=FailureKind.SCOPE_CONFLICT,
            metadata=metadata,
        )

    basic_step_runner._run_agent = run_agent
    basic_step_runner._plan_transition_policy_patch_applied = True


def _active_plan_path(step, context) -> Path | None:
    candidates = [context.active_plan_path, context.metadata.get("active_plan_path")]
    candidates.extend((*step.inputs, *step.outputs))
    for candidate in candidates:
        if candidate is None:
            continue
        path = Path(str(candidate))
        if _is_active_plan_path(path):
            return path

    work_item_id = context.metadata.get("active_work_item_id")
    if isinstance(work_item_id, str) and work_item_id:
        return Path("docs/plans/active") / work_item_id / "plan.md"
    return None


def _is_active_plan_path(path: Path) -> bool:
    return (
        len(path.parts) == 5
        and path.parts[:3] == ("docs", "plans", "active")
        and path.name == "plan.md"
    )


def _completed_plan_path(active_path: Path) -> Path:
    return Path("docs", "plans", "completed", active_path.parts[3], "plan.md")


def _recover_plan_for_retry(active_path: Path, completed_path: Path) -> str | None:
    active_exists = active_path.exists()
    completed_exists = completed_path.exists()
    if active_exists and completed_exists:
        return (
            "plan transition blocked: both active and completed plan paths exist; "
            "retry state is ambiguous"
        )
    if not completed_exists:
        return None
    if completed_path.is_dir():
        return f"plan transition blocked: completed plan path is not a file: {completed_path}"

    active_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(completed_path), str(active_path))
    return None


def _capture_plan_location(
    active_path: Path,
    completed_path: Path,
) -> _PlanLocationSnapshot:
    return _PlanLocationSnapshot(
        active_path=active_path,
        completed_path=completed_path,
        active_exists=active_path.exists(),
        completed_exists=completed_path.exists(),
        active_content=_file_content(active_path),
        completed_content=_file_content(completed_path),
    )


def _file_content(path: Path) -> bytes | None:
    return path.read_bytes() if path.is_file() else None


def _plan_transition_error(step, before: _PlanLocationSnapshot, after: _PlanLocationSnapshot) -> str | None:
    if after.completed_exists:
        return (
            f"plan transition blocked: `{step.id}` created or retained "
            f"`{after.completed_path}`; only `complete-work-item-plan` may move a plan "
            "to the completed path"
        )
    if before.active_exists and not after.active_exists:
        return (
            f"plan transition blocked: `{step.id}` removed `{before.active_path}`; "
            "only `complete-work-item-plan` may remove the active plan"
        )
    if (
        step.agent_id == "implementation_executor"
        and before.active_content is not None
        and after.active_content is not None
        and before.active_content != after.active_content
        and _executor_plan_content_changed_outside_owned_fields(
            before.active_content.decode("utf-8"),
            after.active_content.decode("utf-8"),
        )
    ):
        return (
            "executor plan mutation blocked: only existing checkbox state and the "
            "`## 10. 검증 결과` / `## 10. Verification Results` section are executor-owned"
        )
    return None


def _executor_plan_content_changed_outside_owned_fields(before: str, after: str) -> bool:
    return _canonicalize_executor_plan(before) != _canonicalize_executor_plan(after)


def _canonicalize_executor_plan(text: str) -> str:
    lines: list[str] = []
    in_verification_results = False
    for line in text.splitlines(keepends=True):
        heading = _PLAN_HEADING_RE.match(line)
        if heading:
            title = heading.group(1).strip().lower()
            in_verification_results = (
                "검증 결과" in title or "verification results" in title
            )
            lines.append(f"## {title}\n")
            continue
        if in_verification_results:
            continue
        lines.append(_CHECKBOX_RE.sub(r"\1[ ]", line))
    return "".join(lines)


def _restore_plan_location(before: _PlanLocationSnapshot) -> None:
    if before.active_content is not None:
        _write_file(before.active_path, before.active_content)
    elif before.active_exists:
        # A non-file active path is invalid, but avoid deleting it while reporting.
        pass

    if before.completed_content is not None:
        _write_file(before.completed_path, before.completed_content)
    elif not before.completed_exists:
        _remove_path(before.completed_path)


def _write_file(path: Path, content: bytes) -> None:
    if path.exists() and path.is_dir():
        shutil.rmtree(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)


def _remove_path(path: Path) -> None:
    if path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink()


def _blocked_transition_result(runner_module, step, context, step_dir: Path, error: str, failure_kind):
    evidence = _write_transition_evidence(
        step_dir,
        step_id=step.id,
        active_path=_active_plan_path(step, context),
        completed_path=(
            _completed_plan_path(_active_plan_path(step, context))
            if _active_plan_path(step, context) is not None
            else None
        ),
        error=error,
    )
    result = runner_module._blocked_agent_result(step, context, step_dir, error)
    return replace(
        result,
        failure_kind=failure_kind.SCOPE_CONFLICT,
        metadata={
            **dict(result.metadata),
            "plan_transition_status": "blocked",
            "plan_transition_evidence": str(_relative_to_repo(evidence, context)),
        },
    )


def _write_transition_evidence(
    step_dir: Path,
    *,
    step_id: str,
    active_path: Path | None,
    completed_path: Path | None,
    error: str,
) -> Path:
    evidence = step_dir / "plan-transition.json"
    evidence.write_text(
        json.dumps(
            {
                "step_id": step_id,
                "status": "blocked",
                "active_plan_path": str(active_path) if active_path is not None else None,
                "completed_plan_path": str(completed_path) if completed_path is not None else None,
                "error": error,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return evidence


def _rewrite_result_artifact(
    runner_module,
    step,
    context,
    step_dir: Path,
    *,
    status,
    error: str,
    metadata: dict,
) -> None:
    result_path = step_dir / "result.json"
    result_path.write_text(
        json.dumps(
            {
                "step_id": step.id,
                "agent_id": step.agent_id,
                "skill_id": runner_module._step_skill_id(step),
                "status": status.value,
                "exit_code": None,
                "error": error,
                "metadata": metadata,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    runner_module._write_response_snapshot(context, step.id, result_path)


def _relative_to_repo(path: Path, context) -> Path:
    try:
        return path.relative_to(context.repo_root)
    except ValueError:
        return path
