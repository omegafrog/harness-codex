"""Shared plan-state helpers for the work-item runtime boundary."""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from pathlib import Path


_PLAN_HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
_CHECKBOX_RE = re.compile(r"^(\s*[-*+]\s*)\[[ xX]\]", flags=re.MULTILINE)
_CHECKBOX_LINE_RE = re.compile(r"^(?P<prefix>\s*[-*+]\s*)\[(?P<mark>[ xX])\]\s*(?P<body>.*)$")


@dataclass(frozen=True)
class _PlanLocationSnapshot:
    active_path: Path
    completed_path: Path
    active_exists: bool
    completed_exists: bool
    active_content: bytes | None
    completed_content: bytes | None


def apply_plan_transition_policy_patch() -> None:
    """Retain the public installation hook for the runner-level state guard.

    State enforcement runs around ``BasicStepRunner.run`` in
    ``work_item_plan_state_guard``. Keeping this hook preserves the existing
    bootstrap contract without layering a second agent-only wrapper.
    """


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


def _plan_transition_error(
    step,
    before: _PlanLocationSnapshot,
    after: _PlanLocationSnapshot,
) -> str | None:
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
        before.active_content is not None
        and after.active_content is not None
        and _completed_checkbox_regressed(
            before.active_content.decode("utf-8"),
            after.active_content.decode("utf-8"),
        )
    ):
        return (
            "plan state regression blocked: existing completed checklist items "
            "must not be reset from `- [x]` to `- [ ]`"
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


def _completed_checkbox_regressed(before: str, after: str) -> bool:
    before_checked = {
        _normalize_checkbox_body(match.group("body"))
        for line in before.splitlines()
        if (match := _CHECKBOX_LINE_RE.match(line))
        and match.group("mark").lower() == "x"
    }
    if not before_checked:
        return False
    after_unchecked = {
        _normalize_checkbox_body(match.group("body"))
        for line in after.splitlines()
        if (match := _CHECKBOX_LINE_RE.match(line))
        and match.group("mark") == " "
    }
    return bool(before_checked & after_unchecked)


def _normalize_checkbox_body(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip())


def _executor_plan_content_changed_outside_owned_fields(before: str, after: str) -> bool:
    return _canonicalize_executor_plan(before) != _canonicalize_executor_plan(after)


def _canonicalize_executor_plan(text: str) -> str:
    text = _strip_runtime_metadata(text)
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


def _strip_runtime_metadata(text: str) -> str:
    if not text.startswith("---\n"):
        return text
    boundary = text.find("\n---\n", len("---\n"))
    if boundary < 0:
        return text
    front_matter = text[: boundary + len("\n---\n")]
    if "doc_type: plan" not in front_matter and "contract_version:" not in front_matter:
        return text
    return text[boundary + len("\n---\n") :]


def _restore_plan_location(before: _PlanLocationSnapshot) -> None:
    if before.active_content is not None:
        _write_file(before.active_path, before.active_content)

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
