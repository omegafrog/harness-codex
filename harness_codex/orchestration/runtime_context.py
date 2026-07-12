"""Compact facts for an orchestration parent; never selects a route."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from xml.etree import ElementTree as ET

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
        "review_rejections": _review_rejections(root, workflow, step_root, run_id),
        "steps": [
            {"id": step.id, "kind": step.kind.value, "agent_id": step.agent_id, "skill_id": step.skill_id, "needs": [dependency.step_id for dependency in step.needs], "result_exists": (step_root / step.id / "subagent-result.xml").is_file()}
            for step in workflow.steps
        ],
    }


def _review_rejections(root: Path, workflow, step_root: Path, run_id: str) -> list[dict[str, object]]:
    """리뷰 XML의 evidence와 workflow 산출물 생산자 사실만 전달한다."""
    values: list[dict[str, object]] = []
    for result_path in sorted(step_root.glob("*/subagent-result.xml")):
        try:
            document = ET.parse(result_path).getroot()
        except (OSError, ET.ParseError):
            continue
        outcome = _child(document, "outcome")
        review = _child(document, "review")
        if outcome is None or outcome.get("status") != "blocked" or review is None:
            continue
        evidence = {
            item.get("id"): item.get("path")
            for item in _children(_child(document, "evidence"), "item")
            if item.get("id") and item.get("path")
        }
        findings = []
        for finding in _children(_child(review, "findings"), "finding"):
            if finding.get("severity") != "blocking":
                continue
            evidence_path = evidence.get(finding.get("evidenceRef"))
            if not evidence_path:
                continue
            findings.append(
                {
                    "evidence_path": evidence_path,
                    "message": (_child(finding, "message").text or "").strip() if _child(finding, "message") is not None else "",
                    "producer_step": _producer_step(root, workflow, evidence_path, run_id),
                }
            )
        if findings:
            values.append({"step_id": result_path.parent.name, "findings": findings})
    return values


def _producer_step(root: Path, workflow, evidence_path: str, run_id: str) -> str | None:
    target = Path(evidence_path)
    if target.is_absolute():
        try:
            target = target.relative_to(root)
        except ValueError:
            return None
    for step in workflow.steps:
        for output in step.outputs:
            template = str(output).replace("<RUN-ID>", run_id)
            pattern = re.escape(re.sub(r"<[^>]+>", "__HARNESS_TOKEN__", template)).replace("__HARNESS_TOKEN__", r"[^/]+")
            if re.fullmatch(pattern, target.as_posix()):
                return step.id
    return None


def _children(parent: ET.Element | None, name: str) -> list[ET.Element]:
    return [item for item in list(parent) if item.tag.rsplit("}", 1)[-1] == name] if parent is not None else []


def _child(parent: ET.Element | None, name: str) -> ET.Element | None:
    values = _children(parent, name)
    return values[0] if values else None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args(argv)
    print(json.dumps(context(repo_root=args.repo_root, run_id=args.run_id), ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
