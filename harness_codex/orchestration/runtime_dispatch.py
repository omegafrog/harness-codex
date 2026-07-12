"""Runtime command boundary for an already selected workflow step."""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

from harness_codex.orchestration.specialist_dispatch import dispatch_specialist
from harness_codex.runtime.workflows.loader import load_workflow_file


def dispatch(*, repo_root: Path | str, run_id: str, step_id: str, change_set_id: str, work_item_id: str) -> tuple[str, str]:
    root = Path(repo_root).resolve()
    workflow = load_workflow_file(root / ".harness/workflows/changeset-use-case-workflow.yaml")
    step = workflow.step_by_id(step_id)
    if step is None:
        return "blocked", "unknown_step"
    if step.kind.value == "agent":
        result = dispatch_specialist(repo_root=root, run_id=run_id, step_id=step_id, change_set_id=change_set_id, work_item_id=work_item_id)
        return result.status, result.fact
    if step.kind.value != "validator" or not step.command:
        return "blocked", "non_dispatchable_step"
    command = step.command.replace("<RUN-ID>", run_id).replace("<CHG-ID>", change_set_id).replace("<WORK-ITEM-ID>", work_item_id).replace("<MAINT-ID>", work_item_id)
    completed = subprocess.run(command, cwd=root, shell=True, text=True, capture_output=True, timeout=step.timeout_sec, check=False)
    step_dir = root / ".harness/runs" / run_id / "steps" / step_id
    step_dir.mkdir(parents=True, exist_ok=True)
    (step_dir / "stdout.txt").write_text(completed.stdout, encoding="utf-8")
    (step_dir / "stderr.txt").write_text(completed.stderr, encoding="utf-8")
    return ("succeeded", "validator_result") if completed.returncode == 0 else ("failed", "validator_failure")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--step-id", required=True)
    parser.add_argument("--change-set-id", required=True)
    parser.add_argument("--work-item-id", required=True)
    args = parser.parse_args(argv)
    status, fact = dispatch(repo_root=args.repo_root, run_id=args.run_id, step_id=args.step_id, change_set_id=args.change_set_id, work_item_id=args.work_item_id)
    print(f"status={status}\nfact={fact}")
    return 0 if status == "succeeded" else 1


if __name__ == "__main__":
    raise SystemExit(main())
