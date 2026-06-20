import subprocess
from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.runner import BasicStepRunner


def test_failed_mutating_step_writes_snapshot_and_rollback_report(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    context = RunContext(
        run_id="run-rollback-001",
        workflow_name="test-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-rollback-001/UC-001",
        metadata={
            "change_set_id": "CHG-001",
            "active_work_item_id": "UC-001",
        },
    )
    step = Step(
        id="failing-step",
        kind=StepKind.SHELL,
        name="Fail after writing output",
        command=(
            "python3 -c 'from pathlib import Path; "
            "Path(\"generated.txt\").write_text(\"partial\", encoding=\"utf-8\"); "
            "raise SystemExit(2)'"
        ),
        outputs=(Path("generated.txt"),),
    )

    result = BasicStepRunner().run(step, context)

    assert result.status == StepStatus.FAILED
    snapshot = tmp_path / ".harness/runs/run-rollback-001/snapshots/failing-step"
    assert (snapshot / "git-status-before.txt").is_file()
    assert (snapshot / "git-diff-before.patch").is_file()
    assert (snapshot / "tracked-files.json").is_file()
    assert (snapshot / "planned-output-paths.json").is_file()
    report = tmp_path / ".harness/runs/run-rollback-001/rollback-report.md"
    report_text = report.read_text(encoding="utf-8")
    assert "- Failed step ID: `failing-step`" in report_text
    assert "- Rollback mode: `none`" in report_text
    assert "- `generated.txt`" in report_text
    assert "rollback_report_path" in result.metadata
    assert (tmp_path / "generated.txt").read_text(encoding="utf-8") == "partial"


def test_dirty_repo_failure_reports_limited_rollback(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    (tmp_path / "preexisting.txt").write_text("dirty", encoding="utf-8")
    context = RunContext(
        run_id="run-rollback-dirty",
        workflow_name="test-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-rollback-dirty/UC-001",
        metadata={"change_set_id": "CHG-001", "active_work_item_id": "UC-001"},
    )
    step = Step(
        id="dirty-failing-step",
        kind=StepKind.SHELL,
        name="Fail in dirty repo",
        command="python3 -c 'raise SystemExit(1)'",
    )

    result = BasicStepRunner().run(step, context)

    assert result.status == StepStatus.FAILED
    report = tmp_path / ".harness/runs/run-rollback-dirty/rollback-report.md"
    report_text = report.read_text(encoding="utf-8")
    assert "pre-existing dirty state limits safe rollback" in report_text
    assert "- `preexisting.txt`" in report_text


def test_safe_rollback_reverts_only_planned_outputs(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    context = RunContext(
        run_id="run-rollback-safe",
        workflow_name="test-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-rollback-safe/UC-001",
        metadata={
            "change_set_id": "CHG-001",
            "active_work_item_id": "UC-001",
            "rollback_mode": "safe",
        },
    )
    step = Step(
        id="safe-failing-step",
        kind=StepKind.SHELL,
        name="Fail after planned and extra outputs",
        command=(
            "python3 -c 'from pathlib import Path; "
            "Path(\"generated.txt\").write_text(\"planned\", encoding=\"utf-8\"); "
            "Path(\"extra.txt\").write_text(\"preserve\", encoding=\"utf-8\"); "
            "raise SystemExit(1)'"
        ),
        outputs=(Path("generated.txt"),),
    )

    result = BasicStepRunner().run(step, context)

    assert result.status == StepStatus.FAILED
    assert not (tmp_path / "generated.txt").exists()
    assert (tmp_path / "extra.txt").read_text(encoding="utf-8") == "preserve"
    report_text = (tmp_path / ".harness/runs/run-rollback-safe/rollback-report.md").read_text(
        encoding="utf-8"
    )
    assert "- Rollback mode: `safe`" in report_text
    assert "safe rollback reverted only known planned output paths" in report_text
    assert "## Files Reverted\n\n- `generated.txt`" in report_text
    assert "## Files Preserved" in report_text
    assert "- `extra.txt`" in report_text


def test_git_rollback_restores_changed_paths_and_preserves_runtime_artifacts(
    tmp_path: Path,
) -> None:
    _init_git_repo(tmp_path)
    context = RunContext(
        run_id="run-rollback-git",
        workflow_name="test-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-rollback-git/UC-001",
        metadata={
            "change_set_id": "CHG-001",
            "active_work_item_id": "UC-001",
            "rollback_mode": "git",
        },
    )
    step = Step(
        id="git-failing-step",
        kind=StepKind.SHELL,
        name="Fail after tracked and untracked changes",
        command=(
            "python3 -c 'from pathlib import Path; "
            "Path(\"README.md\").write_text(\"changed\", encoding=\"utf-8\"); "
            "Path(\"new.txt\").write_text(\"new\", encoding=\"utf-8\"); "
            "raise SystemExit(1)'"
        ),
    )

    result = BasicStepRunner().run(step, context)

    assert result.status == StepStatus.FAILED
    assert (tmp_path / "README.md").read_text(encoding="utf-8") == "# Test\n"
    assert not (tmp_path / "new.txt").exists()
    report = tmp_path / ".harness/runs/run-rollback-git/rollback-report.md"
    assert report.is_file()
    report_text = report.read_text(encoding="utf-8")
    assert "- Rollback mode: `git`" in report_text
    assert "git rollback restored changed repository paths" in report_text
    assert "## Files Reverted" in report_text
    assert "- `README.md`" in report_text
    assert "## Files Preserved" in report_text
    assert "- `.harness/`" in report_text


def _init_git_repo(path: Path) -> None:
    subprocess.run(("git", "init"), cwd=path, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(
        ("git", "config", "user.email", "test@example.com"),
        cwd=path,
        check=True,
    )
    subprocess.run(
        ("git", "config", "user.name", "Test User"),
        cwd=path,
        check=True,
    )
    (path / "README.md").write_text("# Test\n", encoding="utf-8")
    subprocess.run(("git", "add", "README.md"), cwd=path, check=True)
    subprocess.run(
        ("git", "commit", "-m", "init"),
        cwd=path,
        check=True,
        stdout=subprocess.DEVNULL,
    )
