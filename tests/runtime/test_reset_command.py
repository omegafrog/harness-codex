import argparse
from pathlib import Path

from harness_codex.runtime.reset import (
    RUN_STATE_PATHS,
    WORKFLOW_ARTIFACT_PATHS,
    build_parser,
    run_reset,
)


def parse_args(*args: str) -> argparse.Namespace:
    return build_parser().parse_args(list(args))


def test_reset_runs_is_dry_run_by_default(tmp_path: Path):
    target = tmp_path / ".harness/runs/run-1"
    target.mkdir(parents=True)
    marker = target / "state.json"
    marker.write_text("{}", encoding="utf-8")

    result = run_reset(tmp_path, parse_args("--runs"))

    assert result.applied is False
    assert result.targets == RUN_STATE_PATHS
    assert Path(".harness/runs") in result.affected
    assert marker.exists()


def test_reset_runs_apply_removes_only_run_state(tmp_path: Path):
    run_state = tmp_path / ".harness/runs/run-1"
    run_state.mkdir(parents=True)
    run_state.joinpath("state.json").write_text("{}", encoding="utf-8")

    change_set = tmp_path / "docs/changes/active/CHG-001.md"
    change_set.parent.mkdir(parents=True)
    change_set.write_text("# change", encoding="utf-8")

    result = run_reset(tmp_path, parse_args("--runs", "--apply"))

    assert result.applied is True
    assert not (tmp_path / ".harness/runs").exists()
    assert change_set.exists()


def test_reset_workflow_artifacts_apply_preserves_run_state(tmp_path: Path):
    run_state = tmp_path / ".harness/runs/run-1/state.json"
    run_state.parent.mkdir(parents=True)
    run_state.write_text("{}", encoding="utf-8")

    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("# plan", encoding="utf-8")

    result = run_reset(tmp_path, parse_args("--workflow-artifacts", "--apply"))

    assert result.applied is True
    assert result.targets == WORKFLOW_ARTIFACT_PATHS
    assert run_state.exists()
    assert not (tmp_path / "docs/plans").exists()


def test_reset_all_targets_both_groups(tmp_path: Path):
    result = run_reset(tmp_path, parse_args("--all"))

    assert result.targets == RUN_STATE_PATHS + WORKFLOW_ARTIFACT_PATHS
