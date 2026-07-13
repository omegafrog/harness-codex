"""Compact facts for an orchestration parent; never selects a route."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from xml.etree import ElementTree as ET

from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.subagent_contract import (
    SubagentContractError,
    read_subagent_invocation,
    read_subagent_result,
    validate_subagent_handoff,
)
from harness_codex.runtime.workflows.loader import load_workflow_file


_MAINTENANCE_SLICE_DOCUMENTS = (
    "index.md",
    "scope.md",
    "change-intent.md",
    "maintenance-spec.md",
    "architecture-impact.md",
    "verification-goal.md",
    "links.md",
)

_WORK_ITEM_RESUME_STEPS = (
    "plan-work-item",
    "review-work-item-plan",
    "materialize-execution-scope",
    "execute-work-item",
    "materialize-execution-report",
    "verify-work-item",
    "materialize-security-profile",
    "collect-pre-security-token-metrics",
    "materialize-security-review-bundle",
    "review-work-item-security",
    "verify-work-item-security",
    "collect-work-item-token-metrics",
)


def context(*, repo_root: Path | str, run_id: str) -> dict[str, object]:
    root = Path(repo_root).resolve()
    workflow = load_workflow_file(root / ".harness/workflows/changeset-use-case-workflow.yaml")
    step_root = root / ".harness/runs" / run_id / "steps"
    active = []
    dispatchable_resume_steps = []
    stale_steps = _stale_agent_steps(root, workflow, step_root, run_id)
    failed_steps = _failed_validator_steps(root, workflow, step_root, run_id)
    for path in sorted((root / "docs/changes/active").glob("*.md")):
        change_set = parse_changeset_markdown(path.read_text(encoding="utf-8"), path=path.relative_to(root))
        work_items = []
        for item in change_set.ordered_work_items():
            slice_path = root / item.slice_path
            slice_ready = item.work_item_type.value != "maintenance" or _maintenance_slice_ready(slice_path)
            work_items.append({
                "id": item.work_item_id,
                "type": item.work_item_type.value,
                "slice_exists": slice_path.is_dir(),
                "slice_ready": slice_ready,
                "plan_exists": (root / "docs/plans/active" / item.work_item_id / "plan.md").is_file(),
            })
        for item in work_items:
            if item["slice_ready"] and item["plan_exists"]:
                candidate = _resume_candidate(workflow, step_root, stale_steps)
                if candidate:
                    dispatchable_resume_steps.append({"change_set_id": change_set.change_set_id, "work_item_id": item["id"], "step_id": candidate})
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
        "stale_steps": stale_steps,
        "failed_steps": failed_steps,
        "review_rejections": _review_rejections(root, workflow, step_root, run_id),
        "steps": [
            {"id": step.id, "kind": step.kind.value, "agent_id": step.agent_id, "skill_id": step.skill_id, "needs": [dependency.step_id for dependency in step.needs], "result_exists": (step_root / step.id / "subagent-result.xml").is_file()}
            for step in workflow.steps
        ],
    }


def _resume_candidate(workflow, step_root: Path, stale_steps: list[dict[str, object]]) -> str | None:
    stale_ids = {str(item["step_id"]) for item in stale_steps}
    for step_id in _WORK_ITEM_RESUME_STEPS:
        step = workflow.step_by_id(step_id)
        if step is None:
            continue
        if step_id in stale_ids or _step_status(step_root / step_id) != "succeeded":
            return step_id
    return None


def _stale_agent_steps(root: Path, workflow, step_root: Path, run_id: str) -> list[dict[str, object]]:
    values: list[dict[str, object]] = []
    for step in workflow.steps:
        if step.kind.value != "agent":
            continue
        invocation_path = step_root / step.id / "subagent-invocation.xml"
        if not invocation_path.is_file():
            continue
        try:
            invocation = read_subagent_invocation(invocation_path)
        except (OSError, ET.ParseError, SubagentContractError):
            values.append({"step_id": step.id, "reason": "invalid_invocation"})
            continue
        result_path = step_root / step.id / "subagent-result.xml"
        if result_path.is_file():
            try:
                result = read_subagent_result(result_path)
                validate_subagent_handoff(
                    invocation,
                    result,
                    run_id=run_id,
                    step_id=step.id,
                    agent_id=step.agent_id,
                    skill_id=step.skill_id,
                )
            except (ET.ParseError, SubagentContractError) as exc:
                values.append({"step_id": step.id, "reason": "invalid_result_contract", "message": str(exc)})
                continue
        declared = {
            item.get("path"): item.get("sha256")
            for item in _descendants(invocation, "artifact")
            if item.get("path") and item.get("sha256")
        }
        missing, changed = [], []
        for path in _required_existing_inputs(root, step, run_id):
            current_hash = _sha256(root / path)
            if path not in declared:
                missing.append(path)
            elif declared[path] != current_hash:
                changed.append(path)
        if missing or changed:
            values.append({"step_id": step.id, "reason": "declared_input_stale", "missing_inputs": missing, "changed_inputs": changed})
    return values


def _required_existing_inputs(root: Path, step, run_id: str) -> list[str]:
    optional = {str(value) for value in step.metadata.get("optional_inputs", ())}
    values = []
    for raw in step.inputs:
        raw_text = str(raw)
        path = _render_path(raw_text, run_id)
        if raw_text in optional and not (root / path).is_file():
            continue
        if (root / path).is_file():
            values.append(path)
    return values


def _failed_validator_steps(root: Path, workflow, step_root: Path, run_id: str) -> list[dict[str, object]]:
    values: list[dict[str, object]] = []
    for step in workflow.steps:
        if step.kind.value != "validator" or _step_status(step_root / step.id) != "failed":
            continue
        producers = []
        for raw in step.inputs:
            producer = _producer_step(root, workflow, _render_path(str(raw), run_id), run_id)
            if producer and producer not in producers:
                producers.append(producer)
        evidence_path = step_root / step.id / "stderr.txt"
        values.append({
            "step_id": step.id,
            "fact": "validator_failure",
            "input_producers": producers,
            "evidence": evidence_path.read_text(encoding="utf-8").strip() if evidence_path.is_file() else "",
        })
    return values


def _render_path(path: str, run_id: str) -> str:
    return path.replace("<RUN-ID>", run_id)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _maintenance_slice_ready(path: Path) -> bool:
    return path.is_dir() and all((path / name).is_file() for name in _MAINTENANCE_SLICE_DOCUMENTS)


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
                    "producer_updated": _producer_updated(step_root, result_path, _producer_step(root, workflow, evidence_path, run_id)),
                }
            )
        if findings:
            values.append({"step_id": result_path.parent.name, "findings": findings})
    return values


def _producer_updated(step_root: Path, review_result_path: Path, producer_step: str | None) -> bool:
    if not producer_step:
        return False
    producer_result = step_root / producer_step / "subagent-result.xml"
    return producer_result.is_file() and producer_result.stat().st_mtime_ns > review_result_path.stat().st_mtime_ns


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


def _step_status(step_dir: Path) -> str | None:
    result_xml = step_dir / "subagent-result.xml"
    if result_xml.is_file():
        try:
            outcome = _child(ET.parse(result_xml).getroot(), "outcome")
            status = outcome.get("status") if outcome is not None else None
            return "succeeded" if status == "completed" else status
        except ET.ParseError:
            return "failed"
    result_path = step_dir / "result.txt"
    if result_path.is_file():
        for line in result_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("status="):
                return line.removeprefix("status=").strip()
    return None


def _children(parent: ET.Element | None, name: str) -> list[ET.Element]:
    return [item for item in list(parent) if item.tag.rsplit("}", 1)[-1] == name] if parent is not None else []


def _descendants(parent: ET.Element, name: str) -> list[ET.Element]:
    return [item for item in parent.iter() if item.tag.rsplit("}", 1)[-1] == name]


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
