"""Runtime integration for verification-driven implementation repair.

The verification classifier is intentionally small and dependency-free.  This module is
loaded lazily after a structured verification failure so the existing work-item loop
can enrich its remediation artifact and the next executor prompt without changing the
workflow definition.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.models import StepStatus


_PATCH_APPLIED = False


def apply_verification_routing_engine_patch() -> None:
    """Install the repair-brief behavior once in the current runtime process."""

    global _PATCH_APPLIED
    if _PATCH_APPLIED:
        return

    # Import lazily: this module is loaded while the runner is already executing a
    # verification failure, so importing it at module load time would create a cycle.
    from harness_codex.runtime import runner as runner_module

    original_run_record = runner_module.BasicStepRunner._run_record
    original_build_agent_prompt = runner_module.build_agent_prompt

    def patched_run_record(self, step, context, step_dir):
        result = original_run_record(self, step, context, step_dir)
        if (
            result.status is StepStatus.SUCCEEDED
            and step.metadata.get("loop_target")
            and _is_implementation_remediation(context)
        ):
            _materialize_repair_brief_and_plan(context)
        return result

    def patched_build_agent_prompt(*, step, context, agent_config, agent_config_path, skill_path=None, skill_body=None):
        prompt = original_build_agent_prompt(
            step=step,
            context=context,
            agent_config=agent_config,
            agent_config_path=agent_config_path,
            skill_path=skill_path,
            skill_body=skill_body,
        )
        if step.agent_id != "implementation_executor":
            return prompt

        brief_path = _repair_brief_path(context)
        if not brief_path.is_file():
            return prompt

        relative_brief = _relative_to_repo(brief_path, context.repo_root)
        return "\n\n".join(
            (
                prompt.rstrip(),
                "## Runtime Repair Context\n\n"
                "This is a verification-driven repair attempt for the active work item.\n\n"
                f"Read `{relative_brief}` before editing.\n\n"
                "Required behavior:\n"
                "1. Fix only the unmet obligation and failed verification described in the repair brief.\n"
                "2. Run the failed verification commands first.\n"
                "3. After the focused repair passes, run every applicable required verification gate.\n"
                "4. Do not weaken tests, acceptance criteria, scope boundaries, or verification goals.\n"
                "5. Stop and report a blocker when the repair requires a ChangeSet or design change.",
            )
        ) + "\n"

    runner_module.BasicStepRunner._run_record = patched_run_record
    runner_module.build_agent_prompt = patched_build_agent_prompt
    _PATCH_APPLIED = True


def _is_implementation_remediation(context) -> bool:
    return str(context.metadata.get("runtime_failure_kind") or "").lower() in {
        "implementation",
        "implementation_failure",
    }


def _repair_brief_path(context) -> Path:
    work_item_id = str(context.metadata.get("active_work_item_id") or "")
    return (
        context.repo_root
        / ".harness"
        / "runs"
        / context.run_id
        / "work-items"
        / work_item_id
        / "verification"
        / "repair-brief.json"
    )


def _verification_report_path(context) -> Path:
    work_item_id = str(context.metadata.get("active_work_item_id") or "")
    return (
        context.repo_root
        / ".harness"
        / "runs"
        / context.run_id
        / "work-items"
        / work_item_id
        / "verification"
        / "report.json"
    )


def _materialize_repair_brief_and_plan(context) -> None:
    report_path = _verification_report_path(context)
    if not report_path.is_file():
        return

    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return
    if not isinstance(report, Mapping):
        return

    brief_path = _repair_brief_path(context)
    brief_path.parent.mkdir(parents=True, exist_ok=True)
    retry_count = _positive_int(context.metadata.get("runtime_retry_count"), default=1)
    failure_metadata = context.metadata.get("runtime_failure_metadata")
    runtime_failure = failure_metadata if isinstance(failure_metadata, Mapping) else {}
    report_relative = _relative_to_repo(report_path, context.repo_root)
    brief_relative = _relative_to_repo(brief_path, context.repo_root)

    brief = {
        "schema_version": 1,
        "change_set_id": context.metadata.get("change_set_id"),
        "work_item_id": context.metadata.get("active_work_item_id"),
        "run_id": context.run_id,
        "repair_attempt": retry_count,
        "resume_target": "execute-work-item",
        "failure": {
            "class": report.get("failure_class") or context.metadata.get("runtime_failure_kind"),
            "fingerprint": report.get("failure_fingerprint"),
            "failed_step": context.metadata.get("runtime_failed_step_id") or "verify-work-item",
            "verification_report": str(report_relative),
            "failed_gates": _string_list(report.get("failed_gates")),
            "failed_commands": _mapping_list(report.get("failed_commands")),
            "unmet_obligations": _string_list(
                report.get("unmet_obligations") or report.get("missing_obligations")
            ),
            "evidence": _string_list(report.get("evidence")),
            "runtime_metadata": dict(runtime_failure),
        },
        "repair_contract": {
            "allowed_changes": [
                "approved code, tests, configuration, and verification evidence inside the active Work Item",
                "unchecked implementation tasks and Runtime Remediation entries in the active plan",
            ],
            "prohibited_changes": [
                "weakening tests, acceptance criteria, scope boundaries, or verification goals",
                "editing unrelated Work Items or ChangeSets",
                "moving the active plan to completed",
            ],
        },
        "verification_order": [
            "Run every failed verification command first.",
            "Then run all applicable required verification gates before completion.",
        ],
    }
    brief_path.write_text(json.dumps(brief, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    active_plan_value = context.metadata.get("active_plan_path")
    if not isinstance(active_plan_value, str) or not active_plan_value:
        return
    active_plan_path = context.repo_root / active_plan_value
    if not active_plan_path.is_file():
        return

    marker = f"Repair brief: `{brief_relative}`"
    plan_text = active_plan_path.read_text(encoding="utf-8")
    if marker in plan_text:
        return
    details = [
        f"  - {marker}",
        "  - Re-verification order:",
        "    1. Run the failed verification commands first.",
        "    2. Run all applicable required verification gates before completion.",
    ]
    active_plan_path.write_text(plan_text.rstrip() + "\n" + "\n".join(details) + "\n", encoding="utf-8")


def _relative_to_repo(path: Path, repo_root: Path) -> Path:
    try:
        return path.relative_to(repo_root)
    except ValueError:
        return path


def _positive_int(value: object, *, default: int) -> int:
    try:
        return max(int(value), 1)
    except (TypeError, ValueError):
        return default


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, (str, int, float))]


def _mapping_list(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [dict(item) for item in value if isinstance(item, Mapping)]
