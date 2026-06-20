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
