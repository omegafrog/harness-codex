"""Runtime command boundary for an already selected workflow step."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path
from xml.etree import ElementTree as ET

from harness_codex.orchestration.specialist_dispatch import dispatch_specialist
from harness_codex.runtime.changes.parser import parse_changeset_markdown
from harness_codex.runtime.token_observability import collect_orchestration_metrics
from harness_codex.runtime.workflows.loader import load_workflow_file


def dispatch(*, repo_root: Path | str, run_id: str, step_id: str, change_set_id: str = "", work_item_id: str = "") -> tuple[str, str]:
    root = Path(repo_root).resolve()
    workflow = load_workflow_file(root / ".harness/workflows/changeset-use-case-workflow.yaml")
    step = workflow.step_by_id(step_id)
    if step is None:
        return "blocked", "unknown_step"
    unmet = _unmet_known_needs(root, run_id, step.needs)
    if unmet:
        return "blocked", f"unmet_needs:{unmet}"
    if step.metadata.get("condition") == "active_change_set_missing" and any((root / "docs/changes/active").glob("*.md")):
        _write_skipped_step(root, run_id, step_id)
        return "succeeded", "condition_skipped"
    change_set_id, work_item_id = _resolve_scope(root, change_set_id, work_item_id)
    if step.kind.value == "agent":
        result = dispatch_specialist(repo_root=root, run_id=run_id, step_id=step_id, change_set_id=change_set_id, work_item_id=work_item_id)
        _write_step_result(root, run_id, step_id, result.status, result.fact)
        collect_orchestration_metrics(repo_root=root, run_id=run_id)
        return result.status, result.fact
    if step.kind.value != "validator" or not step.command:
        return "blocked", "non_dispatchable_step"
    command = step.command.replace("<RUN-ID>", run_id).replace("<CHG-ID>", change_set_id).replace("<WORK-ITEM-ID>", work_item_id).replace("<MAINT-ID>", work_item_id)
    completed = subprocess.run(command, cwd=root, shell=True, text=True, capture_output=True, timeout=step.timeout_sec, check=False)
    step_dir = root / ".harness/runs" / run_id / "steps" / step_id
    step_dir.mkdir(parents=True, exist_ok=True)
    (step_dir / "stdout.txt").write_text(completed.stdout, encoding="utf-8")
    (step_dir / "stderr.txt").write_text(completed.stderr, encoding="utf-8")
    status = "succeeded" if completed.returncode == 0 else "failed"
    (step_dir / "result.txt").write_text(f"status={status}\nexit_code={completed.returncode}\n", encoding="utf-8")
    collect_orchestration_metrics(repo_root=root, run_id=run_id)
    return (status, "validator_result" if status == "succeeded" else "validator_failure")


def _write_skipped_step(root: Path, run_id: str, step_id: str) -> None:
    _write_step_result(root, run_id, step_id, "skipped")


def _write_step_result(root: Path, run_id: str, step_id: str, status: str, fact: str = "") -> None:
    step_dir = root / ".harness/runs" / run_id / "steps" / step_id
    step_dir.mkdir(parents=True, exist_ok=True)
    detail = f"fact={fact}\n" if fact else ""
    (step_dir / "result.txt").write_text(f"status={status}\n{detail}", encoding="utf-8")


def _resolve_scope(root: Path, change_set_id: str, work_item_id: str) -> tuple[str, str]:
    if change_set_id and work_item_id:
        return change_set_id, work_item_id
    active = sorted((root / "docs/changes/active").glob("*.md"))
    if len(active) != 1:
        return change_set_id, work_item_id
    change_set = parse_changeset_markdown(active[0].read_text(encoding="utf-8"), path=active[0].relative_to(root))
    selected = next((item for item in change_set.ordered_work_items() if item.work_item_type.value == "maintenance"), None)
    return change_set.change_set_id, selected.work_item_id if selected else work_item_id


def _unmet_known_needs(root: Path, run_id: str, needs) -> str | None:
    for dependency in needs:
        status = _step_status(root / ".harness/runs" / run_id / "steps" / dependency.step_id)
        if status is not None and status not in dependency.allowed_outcomes:
            return dependency.step_id
    return None


def _step_status(step_dir: Path) -> str | None:
    result = step_dir / "result.txt"
    if result.is_file():
        for line in result.read_text(encoding="utf-8").splitlines():
            if line.startswith("status="):
                return line.removeprefix("status=").strip()
    result_xml = step_dir / "subagent-result.xml"
    if result_xml.is_file():
        try:
            root = ET.parse(result_xml).getroot()
            for child in root:
                if child.tag.rsplit("}", 1)[-1] == "outcome":
                    status = child.get("status")
                    return "succeeded" if status == "completed" else status
        except ET.ParseError:
            return "failed"
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--step-id", required=True)
    parser.add_argument("--change-set-id", default="")
    parser.add_argument("--work-item-id", default="")
    args = parser.parse_args(argv)
    status, fact = dispatch(repo_root=args.repo_root, run_id=args.run_id, step_id=args.step_id, change_set_id=args.change_set_id, work_item_id=args.work_item_id)
    print(f"status={status}\nfact={fact}")
    return 0 if status == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
