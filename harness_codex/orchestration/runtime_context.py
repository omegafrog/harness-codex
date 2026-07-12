"""Compact facts for an orchestration parent; never selects a route."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.workflows.loader import load_workflow_file


def context(*, repo_root: Path | str, run_id: str) -> dict[str, object]:
    root = Path(repo_root).resolve()
    workflow = load_workflow_file(root / ".harness/workflows/changeset-use-case-workflow.yaml")
    step_root = root / ".harness/runs" / run_id / "steps"
    active = []
    dispatchable_resume_steps = []
    for path in sorted((root / "docs/changes/active").glob("*.md")):
        change_set = parse_changeset_markdown(path.read_text(encoding="utf-8"), path=path.relative_to(root))
        work_items = [
            {
                "id": item.work_item_id,
                "type": item.work_item_type.value,
                "slice_exists": (root / item.slice_path).is_dir(),
                "plan_exists": (root / "docs/plans/active" / item.work_item_id / "plan.md").is_file(),
            }
            for item in change_set.ordered_work_items()
        ]
        for item in work_items:
            if item["slice_exists"] and item["plan_exists"]:
                dispatchable_resume_steps.append({"change_set_id": change_set.change_set_id, "work_item_id": item["id"], "step_id": "review-work-item-plan"})
        active.append({
            "change_set_id": change_set.change_set_id,
            "path": str(path.relative_to(root)),
            "work_items": work_items,
        })
    return {
        "run_id": run_id,
        "workflow": str(workflow.source_path),
        "active_change_sets": active,
        "dispatchable_resume_steps": dispatchable_resume_steps,
        "steps": [
            {"id": step.id, "kind": step.kind.value, "agent_id": step.agent_id, "skill_id": step.skill_id, "needs": [dependency.step_id for dependency in step.needs], "result_exists": (step_root / step.id / "subagent-result.xml").is_file()}
            for step in workflow.steps
        ],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)
    print(json.dumps(context(repo_root=args.repo_root, run_id=args.run_id), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
