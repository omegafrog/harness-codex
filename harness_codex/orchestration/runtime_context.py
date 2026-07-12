"""Compact facts for an orchestration parent; never selects a route."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from harness_codex.runtime.workflows.loader import load_workflow_file


def context(*, repo_root: Path | str, run_id: str) -> dict[str, object]:
    root = Path(repo_root).resolve()
    workflow = load_workflow_file(root / ".harness/workflows/changeset-use-case-workflow.yaml")
    step_root = root / ".harness/runs" / run_id / "steps"
    return {
        "run_id": run_id,
        "workflow": str(workflow.source_path),
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
