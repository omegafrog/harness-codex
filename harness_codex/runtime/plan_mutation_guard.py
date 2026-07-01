"""Guard implementation plan repair loops."""

from __future__ import annotations

import difflib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.artifact_boundary import is_evolve_context
from harness_codex.runtime.models import FailureKind, RunContext, Step


PLAN_MUTATION_REQUEST_SCHEMA_VERSION = 1

_CHECKBOX_RE = re.compile(r"^\s*-\s+\[(?P<mark>[ xX])\]\s+(?P<body>.+?)\s*$")
_TASK_ID_RE = re.compile(r"^(?P<id>[A-Z][A-Z0-9_-]*-\d+[A-Z]?)\b")
_SECTION_RE = re.compile(r"^##\s+(?P<title>.+?)\s*$")


@dataclass(frozen=True)
class PlanMutationGuardResult:
    passed: bool
    message: str
    report: dict[str, Any]


def plan_mutation_request_for_context(context: RunContext) -> dict[str, Any] | None:
    retry_count = _int_value(context.metadata.get("runtime_retry_count"))
    failed_step = _text(context.metadata.get("runtime_failed_step_id"))
    failure_kind = _text(context.metadata.get("runtime_failure_kind"))
    if retry_count <= 0 or failed_step is None or failure_kind is None:
        return None
    if failure_kind not in {
        FailureKind.PLAN_REVIEW_REJECTED.value,
        FailureKind.SCOPE_CONFLICT.value,
        FailureKind.IMPLEMENTATION.value,
        FailureKind.UNCLEAR_E2E_GOAL.value,
        FailureKind.ENVIRONMENT_BLOCKER.value,
    }:
        return None
    allowed_sections = {
        FailureKind.SCOPE_CONFLICT.value: (
            "실행 경계",
            "작업 체크리스트",
            "집중 검증",
            "검증 결과",
        ),
        FailureKind.PLAN_REVIEW_REJECTED.value: (
            "실행 경계",
            "패키지 및 의존성 계약",
            "도메인 구현 계약",
            "외부 계약 읽기 허용 목록",
            "작업 체크리스트",
            "집중 검증",
            "완료 조건",
            "검증 결과",
        ),
    }.get(
        failure_kind,
        (
            "작업 체크리스트",
            "집중 검증",
            "검증 결과",
        ),
    )
    return {
        "schema_version": PLAN_MUTATION_REQUEST_SCHEMA_VERSION,
        "mode": "repair",
        "retry_count": retry_count,
        "trigger_step": failed_step,
        "trigger_failure_kind": failure_kind,
        "trigger_error": _text(context.metadata.get("runtime_failure_error")) or "",
        "trigger_metadata": dict(context.metadata.get("runtime_failure_metadata") or {}),
        "allowed_sections": list(allowed_sections),
        "preserve_checked_checkboxes": True,
        "forbid_full_rewrite": False,
        "forbid_unresolved_blocker_tasks": True,
        "forbid_scope_broadening": failure_kind == FailureKind.SCOPE_CONFLICT.value,
        "evolve_allowed": is_evolve_context(
            {**dict(context.metadata), "workflow_name": context.workflow_name}
        ),
    }


def write_plan_mutation_request(
    *,
    context: RunContext,
    step: Step,
    request: Mapping[str, Any],
) -> Path | None:
    plan_path = _plan_output_path(step)
    work_item_id = _work_item_id(context, plan_path)
    if work_item_id is None:
        return None
    output = context.repo_root / ".harness/runs" / context.run_id / "work-items" / work_item_id / "plan-mutation-request.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(request, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return output


def validate_plan_mutation(
    *,
    before: str,
    after: str,
    request: Mapping[str, Any],
) -> PlanMutationGuardResult:
    problems: list[str] = []
    changed_lines = _changed_line_count(before, after)
    max_changed = _int_value(request.get("max_changed_lines"))
    if bool(request.get("forbid_full_rewrite", False)) and max_changed and changed_lines > max_changed:
        problems.append(f"plan repair changed too many lines: {changed_lines} > {max_changed}")

    checked_resets = _checked_checkbox_resets(before, after)
    if bool(request.get("preserve_checked_checkboxes", True)) and checked_resets:
        problems.append("checked checklist items were reset: " + ", ".join(checked_resets[:10]))

    blocker_tasks = _added_unresolved_blocker_tasks(before, after)
    if bool(request.get("forbid_unresolved_blocker_tasks", True)) and blocker_tasks:
        problems.append("unresolved blocker tasks were added: " + ", ".join(blocker_tasks[:5]))

    allowed_sections = {str(item) for item in request.get("allowed_sections", ()) if str(item).strip()}
    outside_sections = _changed_sections_outside_allowlist(before, after, allowed_sections)
    if outside_sections:
        problems.append("plan repair edited sections outside allowlist: " + ", ".join(outside_sections[:10]))

    report = {
        "schema_version": PLAN_MUTATION_REQUEST_SCHEMA_VERSION,
        "mode": request.get("mode"),
        "changed_lines": changed_lines,
        "max_changed_lines": max_changed or None,
        "checked_checkbox_resets": checked_resets,
        "added_unresolved_blocker_tasks": blocker_tasks,
        "changed_sections_outside_allowlist": outside_sections,
        "allowed_sections": sorted(allowed_sections),
    }
    if problems:
        return PlanMutationGuardResult(False, "; ".join(problems), report)
    return PlanMutationGuardResult(True, "plan mutation guard passed", report)


def _plan_output_path(step: Step) -> Path | None:
    for path in step.outputs:
        if len(path.parts) >= 5 and path.parts[:3] == ("docs", "plans", "active") and path.name == "plan.md":
            return path
    return None


def _work_item_id(context: RunContext, plan_path: Path | None) -> str | None:
    value = _text(context.metadata.get("active_work_item_id"))
    if value:
        return value
    if plan_path is not None and len(plan_path.parts) >= 5:
        return plan_path.parts[3]
    return None


def _changed_line_count(before: str, after: str) -> int:
    before_lines = before.splitlines()
    after_lines = after.splitlines()
    count = 0
    for opcode, old_start, old_end, new_start, new_end in difflib.SequenceMatcher(
        a=before_lines,
        b=after_lines,
    ).get_opcodes():
        if opcode != "equal":
            count += (old_end - old_start) + (new_end - new_start)
    return count


def _checked_checkbox_resets(before: str, after: str) -> list[str]:
    before_checked = {
        task_id
        for task_id, mark in _checkbox_ids(before).items()
        if mark.lower() == "x"
    }
    after_marks = _checkbox_ids(after)
    return sorted(task_id for task_id in before_checked if after_marks.get(task_id) == " ")


def _checkbox_ids(text: str) -> dict[str, str]:
    ids: dict[str, str] = {}
    for line in text.splitlines():
        checkbox = _CHECKBOX_RE.match(line)
        if not checkbox:
            continue
        task = _TASK_ID_RE.match(checkbox.group("body"))
        if task:
            ids[task.group("id")] = checkbox.group("mark")
    return ids


def _added_unresolved_blocker_tasks(before: str, after: str) -> list[str]:
    before_lines = set(before.splitlines())
    additions = []
    for line in after.splitlines():
        if line in before_lines:
            continue
        checkbox = _CHECKBOX_RE.match(line)
        if not checkbox or checkbox.group("mark").lower() == "x":
            continue
        body = checkbox.group("body").strip()
        if body.startswith("BLOCKER-") or "token-acquisition" in body or "scope-recovery" in body:
            additions.append(body)
    return additions


def _changed_sections_outside_allowlist(before: str, after: str, allowed_sections: set[str]) -> list[str]:
    if not allowed_sections:
        return []
    after_lines = after.splitlines()
    sections = _section_by_line(after_lines)
    outside: list[str] = []
    for opcode, _old_start, _old_end, new_start, new_end in difflib.SequenceMatcher(
        a=before.splitlines(),
        b=after_lines,
    ).get_opcodes():
        if opcode == "equal":
            continue
        for index in range(new_start, max(new_start + 1, new_end)):
            section = sections.get(index, "<document-preamble>")
            normalized = _normalize_section_title(section)
            if normalized not in allowed_sections and normalized not in outside:
                outside.append(normalized)
    return outside


def _section_by_line(lines: list[str]) -> dict[int, str]:
    current = "<document-preamble>"
    mapping: dict[int, str] = {}
    for index, line in enumerate(lines):
        match = _SECTION_RE.match(line)
        if match:
            current = match.group("title").strip()
        mapping[index] = current
    return mapping


def _normalize_section_title(title: str) -> str:
    return re.sub(r"^\d+\.\s+", "", title.strip())


def _text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _int_value(value: object) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0
