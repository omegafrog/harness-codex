"""Validate and materialize the executor's bounded runtime scope."""

from __future__ import annotations

import argparse
import hashlib
import re
from pathlib import Path
from typing import Mapping, Sequence

from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.changes.models import WorkItemType
from harness_codex.runtime.xml_handoff import write_handoff

_REQUIRED: Mapping[str, tuple[str, ...]] = {
    "execution_scope": ("실행 경계", "Execution Scope"),
    "package_dependency_contract": ("패키지 및 의존성 계약", "Package and Dependency Contract"),
    "domain_implementation_contract": ("도메인 구현 계약", "Domain Implementation Contract"),
    "external_contract_read_allowlist": ("외부 계약 읽기 허용 목록", "External Contract Read Allowlist"),
    "task_checklist": ("작업 체크리스트", "Task Checklist"),
    "focused_verification": ("집중 검증", "Focused Verification"),
}
_PROFILE_REQUIRED: Mapping[str, tuple[str, ...]] = {
    "use_case": (
        "execution_scope",
        "package_dependency_contract",
        "domain_implementation_contract",
        "external_contract_read_allowlist",
        "task_checklist",
        "focused_verification",
    ),
    "maintenance": (
        "task_checklist",
        "focused_verification",
    ),
}
_HEADING = re.compile(r"(?m)^##\s+(.+?)\s*$")
_PLACEHOLDER = re.compile(r"(?:\bTODO\b|\bpending\b|^\s*[-*]\s*\.\.\.\s*$)", re.IGNORECASE)
_ANGLE_PLACEHOLDER = re.compile(r"<([^>]+)>")
_TEMPLATE_PLACEHOLDER_TOKENS = {
    "command",
    "command 또는 n/a+사유",
    "success criteria",
    "expected result",
    "path",
    "file",
    "class",
    "package",
    "todo",
}
_EMPTY_FIELD = re.compile(r"(?:^|[-*]\s*)[^\n:]+:\s*$")


class ExecutionPlanContractError(ValueError):
    """The active plan is not self-sufficient for plan-only execution."""


def materialize_execution_scope(
    *, repo_root: Path, change_set_id: str, work_item_id: str,
    plan_path: Path, output_path: Path, enforce_full_contract: bool = True,
) -> dict[str, object]:
    plan = plan_path if plan_path.is_absolute() else repo_root / plan_path
    if not plan.is_file():
        raise FileNotFoundError(f"active plan is required: {plan_path}")
    text = plan.read_text(encoding="utf-8")
    sections = _sections(text)
    work_item_profile = _work_item_profile(repo_root, change_set_id, work_item_id)
    missing = _invalid_sections(sections, work_item_profile)
    if enforce_full_contract and missing:
        raise ExecutionPlanContractError("executor-ready plan contract is incomplete: " + ", ".join(missing))

    resolved = {}
    for key, aliases in _REQUIRED.items():
        heading = next((alias for alias in aliases if alias in sections), None)
        if heading:
            resolved[key] = {"heading": heading, "content_sha256": _sha(sections[heading])}

    output = output_path if output_path.is_absolute() else repo_root / output_path
    relative_output = Path(_relative(output, repo_root))
    report_path = _execution_report_path_from_scope_output(relative_output, work_item_id)
    plan_sha256 = _sha(text)
    plan_fingerprint = f"sha256:{plan_sha256}"
    payload = {
        "schema_version": 2,
        "change_set_id": change_set_id,
        "work_item_id": work_item_id,
        "work_item_profile": work_item_profile,
        "active_plan_path": _relative(plan, repo_root),
        "plan_sha256": plan_sha256,
        "plan_fingerprint": plan_fingerprint,
        "execution_report_path": str(report_path),
        "read_frontier": _candidate_rows(sections, ("Context Discovery", "컨텍스트 탐색"), ("Read Frontier", "readFrontier", "조회 프론티어")),
        "write_intent": _candidate_rows(sections, ("Write Intent", "수정 의도"), ()),
        "verification_plan": _plain_lines(
            _section_text(sections, ("Verification Plan", "검증 계획", "Focused Regression Plan", "집중 회귀 계획"))
        ),
        "ddd_test_obligations": _plain_lines(
            _section_text(sections, ("DDD Test Obligations", "DDD 테스트 의무"))
        ),
        "runtime_write_authority": {
            "model": "ChangeSet included scope",
            "plan_grants_write_authority": False,
            "plan_file_lists_are_exhaustive": False,
            "product_implementation_categories": [
                "source code",
                "tests",
                "build files",
                "maintained execution scripts",
            ],
        },
        "execution_report_contract": {
            "schema_version": 1,
            "required_path": str(report_path),
            "required_plan_fingerprint": plan_fingerprint,
            "instruction": "Write implementation results to the XML execution report. Do not mutate the active plan.",
        },
        "executor_contract": {
            "required_control_plane": [
                ".codex/agents/references/implementation_executor.md",
                ".codex/skills/harness-implementation-executor/SKILL.md",
                ".codex/skills/harness-implementation-executor/references/ddd-implementation-policy.md",
                ".codex/skills/caveman/SKILL.md",
            ],
            "required_task_inputs": [_relative(plan, repo_root), _relative(output, repo_root)],
            "instruction": "Load fixed policy, then execute only unchecked plan tasks. The plan is the sole task-specific instruction.",
        },
        "plan_contract": {
            "status": "valid" if not missing else "legacy-incomplete",
            "enforced": enforce_full_contract,
            "missing_or_incomplete": missing,
            "required_sections": resolved,
        },
        "plan_sections": list(sections),
    }
    write_handoff(output, "execution-scope", payload)
    return payload


def _sections(text: str) -> dict[str, str]:
    matches = list(_HEADING.finditer(text))
    return {
        match.group(1).strip(): text[match.end(): matches[index + 1].start() if index + 1 < len(matches) else len(text)].strip()
        for index, match in enumerate(matches)
    }


def _invalid_sections(sections: Mapping[str, str], work_item_profile: str) -> list[str]:
    errors: list[str] = []
    for key in _PROFILE_REQUIRED.get(work_item_profile, _PROFILE_REQUIRED["use_case"]):
        aliases = _REQUIRED[key]
        heading = next((alias for alias in aliases if alias in sections), None)
        if heading is None:
            errors.append(f"missing section: {aliases[0]}")
        elif not _meaningful(sections[heading]):
            errors.append(f"incomplete section: {heading}")
    return errors


def _meaningful(content: str) -> bool:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if not lines or _PLACEHOLDER.search("\n".join(lines)):
        return False
    if _has_template_placeholder("\n".join(lines)):
        return False
    return not any(_EMPTY_FIELD.search(line) for line in lines)


def _has_template_placeholder(content: str) -> bool:
    """Reject only explicit template gaps, not runtime value examples."""

    for match in _ANGLE_PLACEHOLDER.finditer(content):
        token = match.group(1).strip().lower()
        if token in _TEMPLATE_PLACEHOLDER_TOKENS:
            return True
    return False


def _sha(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _work_item_profile(repo_root: Path, change_set_id: str, work_item_id: str) -> str:
    change_set_path = repo_root / "docs" / "changes" / "active" / f"{change_set_id}.md"
    if change_set_path.is_file():
        change_set = parse_changeset_markdown(
            change_set_path.read_text(encoding="utf-8"),
            path=change_set_path.relative_to(repo_root),
        )
        for item in change_set.ordered_work_items():
            if item.work_item_id == work_item_id:
                return "use_case" if item.work_item_type == WorkItemType.USE_CASE else "maintenance"
    use_case_dir = repo_root / "docs" / "use-cases" / work_item_id
    return "use_case" if use_case_dir.exists() else "maintenance"


def _section_text(sections: Mapping[str, str], names: Sequence[str]) -> str:
    for name in names:
        if name in sections:
            return sections[name]
    return ""


def _candidate_rows(
    sections: Mapping[str, str],
    parent_names: Sequence[str],
    child_names: Sequence[str],
) -> list[dict[str, str]]:
    content = _section_text(sections, parent_names)
    if not content and child_names:
        content = _section_text(sections, child_names)
    elif content and child_names:
        subsection = _subsection_text(content, child_names)
        if subsection:
            content = subsection
    rows: list[dict[str, str]] = []
    for line in content.splitlines():
        stripped = line.strip()
        if not stripped.startswith(("- ", "* ")):
            continue
        body = stripped[2:].strip()
        path_match = re.search(r"`([^`]+)`", body)
        path = path_match.group(1).strip() if path_match else body.split(":", 1)[0].strip()
        if not path:
            continue
        rows.append(
            {
                "path": path,
                "reason": body,
            }
        )
    return rows


def _subsection_text(content: str, names: Sequence[str]) -> str:
    lines = content.splitlines()
    active = False
    collected: list[str] = []
    for line in lines:
        if line.startswith("### "):
            title = line[4:].strip()
            if title in names:
                active = True
                collected = []
                continue
            if active:
                break
        if active:
            collected.append(line)
    return "\n".join(collected).strip()


def _plain_lines(content: str) -> list[str]:
    return [line.strip() for line in content.splitlines() if line.strip()]


def _execution_report_path_from_scope_output(output_path: Path, work_item_id: str) -> Path:
    parts = output_path.parts
    if (
        len(parts) >= 6
        and parts[0] == ".harness"
        and parts[1] == "runs"
        and parts[3] == "work-items"
    ):
        return Path(*parts[:5]) / "execution-report.xml"
    return Path(".harness/runs") / "UNKNOWN" / "work-items" / work_item_id / "execution-report.xml"


def _relative(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", required=True)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--allow-legacy-contract", action="store_true")
    args = parser.parse_args(argv)
    try:
        materialize_execution_scope(
            repo_root=Path(args.repo_root).resolve(), change_set_id=args.change_set,
            work_item_id=args.work_item, plan_path=Path(args.plan), output_path=Path(args.output),
            enforce_full_contract=not args.allow_legacy_contract,
        )
    except (ExecutionPlanContractError, FileNotFoundError) as error:
        print(error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
