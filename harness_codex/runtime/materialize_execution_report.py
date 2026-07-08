"""Materialize the executor's final message into a fixed XML report."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path
from typing import Sequence

from harness_codex.runtime.step_state import write_step_state_handoff
from harness_codex.runtime.xml_handoff import read_handoff, write_handoff


def materialize_execution_report(
    *,
    repo_root: Path,
    scope_path: Path,
    source_path: Path,
    output_path: Path,
) -> None:
    """Bind an execution attempt to the exact execution-scope XML contract."""

    scope = read_handoff(_absolute(repo_root, scope_path), expected_type="execution-scope")
    source = _absolute(repo_root, source_path)
    summary = source.read_text(encoding="utf-8") if source.is_file() else ""
    work_item_dir = _absolute(repo_root, output_path).parent
    execution_json = _load_execution_json(work_item_dir / "execution-report.json")
    payload = {
        "schema_version": 1,
        "change_set_id": scope["change_set_id"],
        "work_item_id": scope["work_item_id"],
        "plan_fingerprint": scope["plan_fingerprint"],
        "execution_scope_path": str(scope_path),
        "executor_final_message_path": str(source_path),
        "summary": summary,
        "changed_files": _changed_files(repo_root),
        "work_item_profile": scope.get("work_item_profile"),
        "consumed": execution_json.get("consumed", {}),
        "frontier_expansion": execution_json.get("frontier_expansion", []),
        "actual_changes": execution_json.get("actual_changes", []),
        "test_evidence": execution_json.get("test_evidence", []),
    }
    write_handoff(_absolute(repo_root, output_path), "execution-report", payload)
    write_step_state_handoff(
        repo_root,
        change_set_id=str(scope["change_set_id"]),
        work_item_id=str(scope["work_item_id"]),
        step_id="materialize-execution-report",
        handoff_type="execution-report",
        payload=payload,
    )


def _changed_files(repo_root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "status", "--porcelain=v1"],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        return []
    return [line[3:] for line in result.stdout.splitlines() if len(line) >= 4]


def _absolute(repo_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else repo_root / path


def _load_execution_json(path: Path) -> dict[str, object]:
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=".")
    parser.add_argument("--scope", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    materialize_execution_report(
        repo_root=Path(args.repo_root).resolve(),
        scope_path=Path(args.scope),
        source_path=Path(args.source),
        output_path=Path(args.output),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
