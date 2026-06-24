import json
import subprocess
from pathlib import Path

from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepStatus,
)
from harness_codex.runtime.runner import AgentRunResult, BasicStepRunner
from harness_codex.runtime.scope_violation_recovery_patch import (
    capture_git_recovery_checkpoint,
    recover_scope_violation,
)


class EditingAgentAdapter:
    def __init__(
        self,
        edits: dict[str, str],
        *,
        status: StepStatus = StepStatus.SUCCEEDED,
        error: str | None = None,
    ) -> None:
        self.edits = edits
        self.status = status
        self.error = error

    def run(self, request) -> AgentRunResult:
        for relative, content in self.edits.items():
            path = request.context.repo_root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        return AgentRunResult(
            status=self.status,
            exit_code=0 if self.status == StepStatus.SUCCEEDED else 17,
            error=self.error,
            metadata={"adapter": "editing"},
        )


def _git(repo_root: Path, *arguments: str, check: bool = True) -> str:
    completed = subprocess.run(
        ["git", *arguments],
        cwd=repo_root,
        text=True,
        capture_output=True,
        check=check,
    )
    return completed.stdout


def _init_repo(repo_root: Path, *, commit: bool = False) -> None:
    _git(repo_root, "init")
    if not commit:
        return
    (repo_root / "baseline.txt").write_text("baseline\n", encoding="utf-8")
    _git(repo_root, "add", "baseline.txt")
    _git(
        repo_root,
        "-c",
        "user.name=Harness Test",
        "-c",
        "user.email=harness@example.test",
        "commit",
        "-m",
        "initial",
    )


def _write_agent_config(repo_root: Path, agent_id: str) -> None:
    agents = repo_root / ".codex" / "agents"
    agents.mkdir(parents=True, exist_ok=True)
    (agents / f"{agent_id}.toml").write_text(
        "\n".join(
            (
                f'name = "{agent_id}"',
                'description = "scope recovery test"',
                'model = "gpt-5.4"',
                'model_reasoning_effort = "medium"',
                'sandbox_mode = "workspace-write"',
                'developer_instructions = "test"',
            )
        ),
        encoding="utf-8",
    )


def _context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="scope-recovery-run",
        workflow_name="scope-recovery-test",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness" / "runs" / "scope-recovery-run",
        metadata={
            "change_set_id": "CHG-001",
            "active_work_item_id": "UC-001",
            "active_plan_path": "docs/plans/active/UC-001/plan.md",
        },
    )


def _agent_step(agent_id: str, output: str) -> Step:
    return Step(
        id=f"{agent_id}-step",
        kind=StepKind.AGENT,
        name=agent_id,
        agent_id=agent_id,
        outputs=(Path(output),),
    )


def test_checkpoint_does_not_move_head_branch_or_visible_history(tmp_path: Path) -> None:
    _init_repo(tmp_path, commit=True)
    (tmp_path / "dirty.txt").write_text("dirty\n", encoding="utf-8")
    before_head = _git(tmp_path, "rev-parse", "HEAD").strip()
    before_branch = _git(tmp_path, "branch", "--show-current").strip()
    before_count = _git(tmp_path, "rev-list", "--count", "HEAD").strip()
    before_status = _git(tmp_path, "status", "--porcelain")

    checkpoint = capture_git_recovery_checkpoint(tmp_path)

    assert _git(tmp_path, "rev-parse", "HEAD").strip() == before_head
    assert _git(tmp_path, "branch", "--show-current").strip() == before_branch
    assert _git(tmp_path, "rev-list", "--count", "HEAD").strip() == before_count
    assert _git(tmp_path, "status", "--porcelain") == before_status
    assert _git(tmp_path, "cat-file", "-e", f"{checkpoint.index_commit}^{{commit}}", check=False) == ""
    assert _git(tmp_path, "cat-file", "-e", f"{checkpoint.worktree_commit}^{{commit}}", check=False) == ""
    assert _git(tmp_path, "branch", "--contains", checkpoint.index_commit) == ""
    assert _git(tmp_path, "branch", "--contains", checkpoint.worktree_commit) == ""


def test_document_agent_recovery_keeps_allowed_output_and_restores_user_state(
    tmp_path: Path,
) -> None:
    _init_repo(tmp_path, commit=True)
    _write_agent_config(tmp_path, "implementation_planner")
    (tmp_path / ".gitignore").write_text("*.ignored\n", encoding="utf-8")
    _git(tmp_path, "add", ".gitignore")
    _git(
        tmp_path,
        "-c",
        "user.name=Harness Test",
        "-c",
        "user.email=harness@example.test",
        "commit",
        "-m",
        "ignore files",
    )

    dirty = tmp_path / "notes" / "user-note.md"
    dirty.parent.mkdir(parents=True)
    dirty.write_text("user draft\n", encoding="utf-8")
    ignored = tmp_path / "existing.ignored"
    ignored.write_text("keep me\n", encoding="utf-8")

    output = "docs/plans/active/UC-001/plan.md"
    runner = BasicStepRunner(
        agent_adapter=EditingAgentAdapter(
            {
                output: "allowed plan\n",
                "notes/user-note.md": "agent overwrote user draft\n",
                "existing.ignored": "agent overwrote ignored file\n",
                "new.ignored": "agent-created ignored file\n",
            }
        )
    )

    result = runner.run(_agent_step("implementation_planner", output), _context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.SCOPE_CONFLICT
    assert (tmp_path / output).read_text(encoding="utf-8") == "allowed plan\n"
    assert dirty.read_text(encoding="utf-8") == "user draft\n"
    assert ignored.read_text(encoding="utf-8") == "keep me\n"
    assert not (tmp_path / "new.ignored").exists()
    assert {"notes/user-note.md", "existing.ignored", "new.ignored"} <= set(
        result.metadata["scope_recovery_recovered_files"]
    )
    assert {"notes/user-note.md", "existing.ignored"} <= set(
        result.metadata["scope_recovery_preserved_preexisting_dirty_files"]
    )

    report_path = tmp_path / result.metadata["scope_recovery_report_path"]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "recovered"
    assert report["scope_diff_report"].endswith("scope-diff-report.json")
    scope_report = json.loads(
        (tmp_path / result.metadata["scope_diff_report_path"]).read_text(encoding="utf-8")
    )
    assert scope_report["recovery"]["recovered_files"] == report["recovered_files"]

    result_path = tmp_path / result.output_path
    result_payload = json.loads(result_path.read_text(encoding="utf-8"))
    assert result_payload["status"] == StepStatus.BLOCKED.value
    assert result_payload["metadata"]["scope_recovery_report_path"] == result.metadata[
        "scope_recovery_report_path"
    ]


def test_executor_failure_with_scope_violation_is_fail_closed_and_recovered(
    tmp_path: Path,
) -> None:
    _init_repo(tmp_path, commit=True)
    _write_agent_config(tmp_path, "implementation_executor")
    output = "docs/plans/active/UC-001/plan.md"
    runner = BasicStepRunner(
        agent_adapter=EditingAgentAdapter(
            {
                output: "allowed output retained after failure\n",
                "unauthorized.py": "agent side effect\n",
            },
            status=StepStatus.FAILED,
            error="agent process failed",
        )
    )

    result = runner.run(_agent_step("implementation_executor", output), _context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.SCOPE_CONFLICT
    assert "agent process failed" in (result.error or "")
    assert not (tmp_path / "unauthorized.py").exists()
    assert (tmp_path / output).read_text(encoding="utf-8") == "allowed output retained after failure\n"
    assert "unauthorized.py" in result.metadata["scope_recovery_detected_files"]
    assert "unauthorized.py" in result.metadata["scope_recovery_recovered_files"]


def test_scope_recovery_preserves_staged_unstaged_and_ignored_content(
    tmp_path: Path,
) -> None:
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("*.ignored\n", encoding="utf-8")
    tracked = tmp_path / "tracked.txt"
    tracked.write_text("base\n", encoding="utf-8")
    _git(tmp_path, "add", ".gitignore", "tracked.txt")
    tracked.write_text("staged-before-agent\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    tracked.write_text("unstaged-before-agent\n", encoding="utf-8")
    existing_ignored = tmp_path / "existing.ignored"
    existing_ignored.write_text("ignored-before-agent\n", encoding="utf-8")

    checkpoint = capture_git_recovery_checkpoint(tmp_path)
    tracked.write_text("agent-change\n", encoding="utf-8")
    _git(tmp_path, "add", "tracked.txt")
    existing_ignored.write_text("agent-overwrite\n", encoding="utf-8")
    new_ignored = tmp_path / "new.ignored"
    new_ignored.write_text("agent-created\n", encoding="utf-8")
    step_dir = tmp_path / ".harness" / "runs" / "run" / "steps" / "agent"
    scope_report = step_dir / "scope-diff-report.json"
    step_dir.mkdir(parents=True)
    scope_report.write_text("{}\n", encoding="utf-8")

    recovery = recover_scope_violation(
        repo_root=tmp_path,
        step_dir=step_dir,
        scope_report_path=scope_report,
        checkpoint=checkpoint,
        blocked_files=("tracked.txt", "existing.ignored", "new.ignored"),
    )

    assert tracked.read_text(encoding="utf-8") == "unstaged-before-agent\n"
    assert _git(tmp_path, "show", ":tracked.txt") == "staged-before-agent\n"
    assert existing_ignored.read_text(encoding="utf-8") == "ignored-before-agent\n"
    assert not new_ignored.exists()
    assert set(recovery.preserved_preexisting_dirty_files) == {
        "tracked.txt",
        "existing.ignored",
    }
