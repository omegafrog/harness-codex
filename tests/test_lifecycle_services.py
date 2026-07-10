from __future__ import annotations

from pathlib import Path
import subprocess

from harness_codex.runtime.lifecycle_services import (
    append_run_event,
    complete_work_item,
    create_run_state,
    prepare_artifact_directories,
    read_execution_report,
    read_run_state,
    update_run_status,
    write_execution_report,
)
from harness_codex.runtime.runtime_services import default_runtime_registry


def test_artifact_directories_are_idempotent_and_preserve_files(tmp_path: Path) -> None:
    payload = {"repo_root": str(tmp_path), "run_id": "run-1", "work_item_id": "WI-1"}
    first = prepare_artifact_directories(payload)
    evidence = Path(first["evidence_dir"]) / "keep.txt"
    evidence.write_text("evidence", encoding="utf-8")
    second = prepare_artifact_directories(payload)

    assert first == second
    assert evidence.read_text(encoding="utf-8") == "evidence"


def test_run_state_round_trip_and_identity_are_local_only(tmp_path: Path) -> None:
    base = {"repo_root": str(tmp_path), "run_id": "run-1", "change_set_id": "CHG-1", "work_item_id": "WI-1"}
    assert create_run_state(base)["status"] == "completed"
    assert append_run_event({**base, "event": {"kind": "agent-result"}})["status"] == "completed"
    assert update_run_status({**base, "status": "running"})["status"] == "completed"
    state = read_run_state(base)

    assert state["state"]["status"] == "running"
    assert state["state"]["events"] == [{"kind": "agent-result"}]
    assert "next_step" not in state
    assert "retry_recommended" not in state
    assert create_run_state({**base, "change_set_id": "CHG-2"})["status"] == "failed"


def test_execution_report_round_trip_checks_plan_fingerprint(tmp_path: Path) -> None:
    payload = {
        "repo_root": str(tmp_path),
        "run_id": "run-1",
        "work_item_id": "WI-1",
        "plan_fingerprint": "sha256:plan",
        "completed_tasks": ["TASK-001"],
        "test_results": [{"command": "pytest", "status": "pass"}],
        "evidence_paths": [".harness/runs/run-1/evidence"],
    }
    written = write_execution_report(payload)
    report = read_execution_report({"report_path": written["report_path"], "plan_fingerprint": "sha256:plan"})

    assert written["status"] == "completed"
    assert report["report"]["completed_tasks"] == ["TASK-001"]
    assert read_execution_report({"report_path": written["report_path"], "plan_fingerprint": "sha256:stale"})["status"] == "failed"


def test_completion_moves_only_the_requested_plan(tmp_path: Path) -> None:
    active = tmp_path / "docs/plans/active/WI-1/plan.md"
    report = tmp_path / ".harness/runs/run-1/work-items/WI-1/execution-report.xml"
    active.parent.mkdir(parents=True)
    report.parent.mkdir(parents=True)
    active.write_text("plan", encoding="utf-8")
    report.write_text("report", encoding="utf-8")

    result = complete_work_item(
        {
            "repo_root": str(tmp_path),
            "active_plan_path": str(active),
            "execution_report_path": str(report),
        }
    )

    assert result["status"] == "completed"
    assert not active.exists()
    assert Path(result["completed_plan_path"]).is_file()
    assert "next_step" not in result
    assert "repair_target" not in result


def test_completion_rejects_stale_execution_report(tmp_path: Path) -> None:
    active = tmp_path / "docs/plans/active/WI-1/plan.md"
    report = tmp_path / ".harness/runs/run-1/work-items/WI-1/execution-report.xml"
    active.parent.mkdir(parents=True)
    active.write_text("plan", encoding="utf-8")
    report.parent.mkdir(parents=True)
    write_execution_report(
        {
            "repo_root": str(tmp_path),
            "run_id": "run-1",
            "work_item_id": "WI-1",
            "plan_fingerprint": "sha256:old",
        }
    )

    result = complete_work_item(
        {
            "repo_root": str(tmp_path),
            "active_plan_path": str(active),
            "execution_report_path": str(report),
            "plan_fingerprint": "sha256:current",
        }
    )

    assert result["status"] == "blocked"
    assert active.exists()


def test_worktree_utility_creates_and_reports_one_worktree(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "config", "user.name", "Test"], check=True)
    (tmp_path / "README.md").write_text("base", encoding="utf-8")
    subprocess.run(["git", "-C", str(tmp_path), "add", "README.md"], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "commit", "-qm", "base"], check=True)
    worktree = tmp_path / "isolated"

    result = default_runtime_registry().run_tool(
        "worktree-setup",
        {
            "repo_root": str(tmp_path),
            "branch_name": "harness/test",
            "requested_path": str(worktree),
            "base_ref": "HEAD",
        },
    )

    assert result["status"] == "completed"
    status = default_runtime_registry().run_tool("worktree-status", {"worktree_path": str(worktree)})
    assert status["status"] == "completed"
    assert status["branch_name"] == "harness/test"


def test_registry_lifecycle_tools_do_not_chain_or_return_routes(tmp_path: Path) -> None:
    registry = default_runtime_registry()
    result = registry.run_tool(
        "artifact-directories",
        {"repo_root": str(tmp_path), "run_id": "run-1", "work_item_id": "WI-1"},
    )

    assert result["status"] == "completed"
    assert set(result).isdisjoint({"next_step", "retry", "repair_target", "workflow_route"})
