"""Validate and materialize the narrow runtime scope consumed by the executor.

The executor receives this artifact with its active plan. It is an execution aid,
not a replacement for runtime write authority: scope-diff validation still
requires ChangeSet and affected-files-manifest permission.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Mapping, Sequence


_REQUIRED_SECTIONS: Mapping[str, tuple[str, ...]] = {
    "execution_scope": ("실행 경계", "Execution Scope"),
    "package_dependency_contract": ("패키지 및 의존성 계약", "Package and Dependency Contract"),
    "domain_implementation_contract": ("도메인 구현 계약", "Domain Implementation Contract"),
    "external_contract_read_allowlist": ("외부 계약 읽기 허용 목록", "External Contract Read Allowlist"),
    "task_checklist": ("작업 체크리스트", "Task Checklist"),
    "focused_verification": ("집중 검증", "Focused Verification"),
}
_SECTION_RE = re.compile(r"(?m)^##\s+(.+?)\s*$")
_EMPTY_FIELD_RE = re.compile(r"(?:^|[-*]\s*)[^\n:]+:\s*$")
_PLACEHOLDER_RE = re.compile(r"(?:<[^>]+>|\bTODO\b|\bpending\b|^\s*[-*]\s*\.\.\.\s*$)", re.IGNORECASE)


class ExecutionPlanContractError(ValueError):
    """Raised when a plan is not self-sufficient for plan-only execution."""


def materialize_execution_scope(
    *,
    repo_root: Path,
    change_set_id: str,
    work_item_id: str,
    plan_path: Path,
    output_path: Path,
    enforce_full_contract: bool = False,
) -> dict[str, object]:
    """Write a scope artifact and optionally enforce the executor-complete contract.

    The Python API keeps the historical permissive default for callers that only
    inspect scope metadata. The workflow CLI enables full enforcement before an
    implementation executor is invoked.
    """

    absolute_plan = plan_path if plan_path.is_absolute() else repo_root / plan_path
    if not absolute_plan.is_file():
        raise FileNotFoundError(f"active plan is required: {plan_path}")

    plan_text = absolute_plan.read_text(encoding="utf-8")
    sections = _extract_sections(plan_text)
    missing = _missing_or_incomplete_sections(sections)
    if enforce_full_contract and missing:
        raise ExecutionPlanContractError(
            "executor-ready plan contract is incomplete: " + ", ".join(missing)
        )

    present_required_sections = {
        key: {"heading": heading, "content_sha256": _content_sha256(sections[heading])}
        for key, aliases in _REQUIRED_SECTIONS.items()
        for heading in (next((alias for alias in aliases if alias in sections), None),)
        if heading is not None
    }
    payload = {
        "schema_version": 2,
        "change_set_id": change_set_id,
        "work_item_id": work_item_id,
        "active_plan_path": _relative(absolute_plan, repo_root),
        "plan_sha256": hashlib.sha256(plan_text.encode("utf-8")).hexdigest(),
        "runtime_write_authority": {
            "model": "ChangeSet included scope ∩ affected-files manifest",
            "plan_grants_write_authority": False,
        },
        "executor_contract": {
            "required_control_plane": [
                ".codex/agents/references/implementation_executor.md",
                ".codex/skills/harness-implementation-executor/SKILL.md",
                ".codex/skills/harness-implementation-executor/references/ddd-implementation-policy.md",
            ],
            "required_task_inputs": [
                _relative(absolute_plan, repo_root),
                _relative(output_path if output_path.is_absolute() else repo_root / output_path, repo_root),
            ],
            "instruction": (
                "Load the fixed control-plane policy, then execute only unchecked plan tasks. "
                "Treat the active plan as the sole task-specific product and implementation "
                "instruction; report a blocker when it is insufficient instead of reading "
                "upstream design artifacts."
            ),
        },
        "plan_contract": {
            "status": "valid" if not missing else "legacy-incomplete",
            "enforced": enforce_full_contract,
            "missing_or_incomplete": missing,
            "required_sections": present_required_sections,
        },
        "plan_sections": list(sections),
    }

    absolute_output = output_path if output_path.is_absolute() else repo_root / output_path
    absolute_output.parent.mkdir(parents=True, exist_ok=True)
    absolute_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def _extract_sections(plan_text: str) -> dict[str, str]:
    matches = list(_SECTION_RE.finditer(plan_text))
    sections: dict[str, str] = {}
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(plan_text)
        sections[match.group(1).strip()] = plan_text[match.end() : end].strip()
    return sections


def _missing_or_incomplete_sections(sections: Mapping[str, str]) -> list[str]:
    errors: list[str] = []
    for _, aliases in _REQUIRED_SECTIONS.items():
        heading = next((alias for alias in aliases if alias in sections), None)
        if heading is None:
            errors.append(f"missing section: {aliases[0]}")
            continue
        if not _meaningful_section(sections[heading]):
            errors.append(f"incomplete section: {heading}")
    return errors


def _meaningful_section(content: str) -> bool:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    if not lines:
        return False
    normalized = "\n".join(lines)
    if _PLACEHOLDER_RE.search(normalized):
        return False
    if any(_EMPTY_FIELD_RE.search(line) for line in lines):
        return False
    if all(line in {"-", "*"} for line in lines):
        return False
    return True


def _content_sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _relative(path: Path, repo_root: Path) -> str:
    try:
        return str(path.relative_to(repo_root))
    except ValueError:
        return str(path)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--change-set", required=True)
    parser.add_argument("--work-item", required=True)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--enforce-full-contract", action="store_true")
    args = parser.parse_args(argv)

    try:
        materialize_execution_scope(
            repo_root=Path(args.repo_root).resolve(),
            change_set_id=args.change_set,
            work_item_id=args.work_item,
            plan_path=Path(args.plan),
            output_path=Path(args.output),
            enforce_full_contract=args.enforce_full_contract,
        )
    except (ExecutionPlanContractError, FileNotFoundError) as error:
        print(str(error))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
