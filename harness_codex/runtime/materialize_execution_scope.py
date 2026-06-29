"""Materialize the narrow runtime scope consumed by the implementation executor.

The executor receives this artifact together with its active plan.  It is an
execution aid, not a replacement for the runtime write authority: scope-diff
validation still requires ChangeSet and affected-files-manifest permission.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Sequence


_SECTION_RE = re.compile(
    r"^##\s+(?:실행\s*경계|Execution\s+Scope|집중\s*검증|Focused\s+Verification)\s*$",
    flags=re.IGNORECASE | re.MULTILINE,
)


def materialize_execution_scope(
    *,
    repo_root: Path,
    change_set_id: str,
    work_item_id: str,
    plan_path: Path,
    output_path: Path,
) -> dict[str, object]:
    """Write a small, runtime-owned execution scope artifact for one work item."""

    absolute_plan = plan_path if plan_path.is_absolute() else repo_root / plan_path
    if not absolute_plan.is_file():
        raise FileNotFoundError(f"active plan is required: {plan_path}")

    plan_text = absolute_plan.read_text(encoding="utf-8")
    payload = {
        "schema_version": 1,
        "change_set_id": change_set_id,
        "work_item_id": work_item_id,
        "active_plan_path": _relative(absolute_plan, repo_root),
        "plan_sha256": hashlib.sha256(plan_text.encode("utf-8")).hexdigest(),
        "runtime_write_authority": {
            "model": "ChangeSet included scope ∩ affected-files manifest",
            "plan_grants_write_authority": False,
        },
        "executor_contract": {
            "required_inputs": [
                _relative(absolute_plan, repo_root),
                _relative(output_path if output_path.is_absolute() else repo_root / output_path, repo_root),
            ],
            "instruction": (
                "Execute only unchecked plan tasks. Treat the active plan as the sole "
                "product and implementation instruction; report a blocker when it is "
                "insufficient instead of reading upstream design artifacts."
            ),
        },
        "plan_sections": _execution_sections(plan_text),
    }

    absolute_output = output_path if output_path.is_absolute() else repo_root / output_path
    absolute_output.parent.mkdir(parents=True, exist_ok=True)
    absolute_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return payload


def _execution_sections(plan_text: str) -> list[str]:
    """Return explicit execution-boundary headings without duplicating plan content."""

    return [match.group(0).lstrip("#").strip() for match in _SECTION_RE.finditer(plan_text)]


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
    args = parser.parse_args(argv)

    materialize_execution_scope(
        repo_root=Path(args.repo_root).resolve(),
        change_set_id=args.change_set,
        work_item_id=args.work_item,
        plan_path=Path(args.plan),
        output_path=Path(args.output),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
