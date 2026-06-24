import json
import subprocess
from pathlib import Path

from harness_codex.runtime.models import (
    AgentRunResult,
    FailureKind,
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepStatus,
)
from harness_codex.runtime.runner import BasicStepRunner


class EditingAgent:
    def __init__(self, edits: dict[str, str], *, status: StepStatus = StepStatus.SUCCEEDED) -> None:
        self.edits = edits
        self.status = status

    def run(self, request):
        for relative, text in self.edits.items():
            target = request.context.repo_root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        return AgentRunResult(status=self.status, exit_code=0, metadata={"fake": True})


def _init_git_repo(repo_root: Path) -> None:
    subprocess.run(("git", "init"), cwd=repo_root, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(
        ("git", "config", "user.email", "test@example.com"),
        cwd=repo_root,
        check=True,
    )
    subprocess.run(
        ("git", "config", "user.name", "Test User"),
        cwd=repo_root,
        check=True,
    )
    (repo_root / "README.md").write_text("# Test\n", encoding="utf-8")
    (repo_root / ".gitignore").write_text("ignored/\n", encoding="utf-8")
    subprocess.run(("git", "add", "README.md", ".gitignore"), cwd=repo_root, check=True)
    subprocess.run(
        ("git", "commit", "-m", "init"),
        cwd=repo_root,
        check=True,
        stdout=subprocess.DEVNULL,
    )


def _write_agent_config(repo_root: Path, agent_id: str) -> None:
    path = repo_root / ".codex/agents" / f"{agent_id}.toml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            [
                f'name = "{agent_id}"',
                'description = "test agent"',
                'model = "gpt-5.4"',
                'sandbox_mode = "danger-full-access"',
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _executor_context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs/run-001/UC-001",
        active_plan_path=Path("docs/plans/active/UC-001/plan.md"),
        metadata={
            "change_set_id": "CHG-001",
            "change_set_path": "docs/changes/active/CHG-001.md",
            "active_work_item_id": "UC-001",
            "active_plan_path": "docs/plans/active/UC-001/plan.md",
            "affected_work_items": [
                {
                    "id": "UC-001",
                    "executor_inputs": ["docs/plans/active/UC-001/plan.md"],
                }
            ],
        },
    )


def _write_executor_scope_inputs(repo_root: Path) -> None:
    plan = repo_root / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("# original plan\n", encoding="utf-8")
    change_set = repo_root / "docs/changes/active/CHG-001.md"
    change_set.parent.mkdir(parents=True, exist_ok=True)
    change_set.write_text(
        "\n".join(
            [
                "# ChangeSet CHG-001",
                "",
                "## 1. Metadata",
                "|Item|Value|",
                "|---|---|",
                "|ChangeSet ID|`CHG-001`|",
                "|Status|active|",
                "",
                "## 8. Scope Boundary",
                "### Included",
                "- `src/reservation/**`",
                "",
                "### Excluded",
                "- `src/payment/**`",
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def test_executor_scope_violation_recovers_new_and_ignored_files_without_losing_dirty_work(
    tmp_path: Path,
) -> None:
    _init_git_repo(tmp_path)
    _write_agent_config(tmp_path, "implementation_executor")
    _write_executor_scope_inputs(tmp_path)
    (tmp_path / "README.md").write_text("user README edit\n", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("user note\n", encoding="utf-8")

    step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute implementation",
        agent_id="implementation_executor",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )
    runner = BasicStepRunner(
        agent_adapter=EditingAgent(
            {
                "docs/plans/active/UC-001/plan.md": "# updated plan\n",
                "src/reservation/ReservationService.py": "class ReservationService: pass\n",
                "README.md": "agent overwrote user edit\n",
                "notes.txt": "agent overwrote user note\n",
                "src/payment/PaymentService.py": "class PaymentService: pass\n",
                "build.gradle": "plugins {}\n",
                "ignored/agent.log": "ignored unauthorized output\n",
            }
        )
    )

    result = runner.run(step, _executor_context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.SCOPE_CONFLICT
    assert (tmp_path / "README.md").read_text(encoding="utf-8") == "user README edit\n"
    assert (tmp_path / "notes.txt").read_text(encoding="utf-8") == "user note\n"
    assert (tmp_path / "docs/plans/active/UC-001/plan.md").read_text(encoding="utf-8") == "# updated plan\n"
    assert (tmp_path / "src/reservation/ReservationService.py").is_file()
    assert not (tmp_path / "src/payment/PaymentService.py").exists()
    assert not (tmp_path / "build.gradle").exists()
    assert not (tmp_path / "ignored/agent.log").exists()

    recovery_report = tmp_path / result.metadata["scope_recovery_report_path"]
    report = json.loads(recovery_report.read_text(encoding="utf-8"))
    assert report["status"] == "recovered"
    assert set(report["detected_files"]) >= {
        "README.md",
        "notes.txt",
        "src/payment/PaymentService.py",
        "build.gradle",
        "ignored/agent.log",
    }
    assert set(report["preserved_preexisting_dirty_files"]) >= {"README.md", "notes.txt"}
    assert report["recovery_failed_files"] == []

    scope_report = json.loads(
        (
            tmp_path
            / ".harness/runs/run-001/UC-001/steps/execute-work-item/scope-diff-report.json"
        ).read_text(encoding="utf-8")
    )
    assert set(scope_report["recovery"]["recovered_files"]) >= {
        "README.md",
        "notes.txt",
        "src/payment/PaymentService.py",
        "build.gradle",
        "ignored/agent.log",
    }
    result_payload = json.loads((tmp_path / result.output_path).read_text(encoding="utf-8"))
    assert result_payload["metadata"]["scope_recovery_failed_files"] == []


def test_document_agent_scope_violation_recovers_unauthorized_write_and_keeps_declared_output(
    tmp_path: Path,
) -> None:
    _init_git_repo(tmp_path)
    _write_agent_config(tmp_path, "implementation_planner")
    context = RunContext(
        run_id="run-doc-001",
        workflow_name="harvest-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-doc-001",
    )
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Plan work item",
        agent_id="implementation_planner",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = BasicStepRunner(
        agent_adapter=EditingAgent(
            {
                "docs/plans/active/UC-001/plan.md": "# declared output\n",
                "README.md": "unauthorized documentation agent change\n",
            }
        )
    ).run(step, context)

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.SCOPE_CONFLICT
    assert (tmp_path / "README.md").read_text(encoding="utf-8") == "# Test\n"
    assert (tmp_path / "docs/plans/active/UC-001/plan.md").read_text(encoding="utf-8") == "# declared output\n"
    report = json.loads(
        (tmp_path / result.metadata["scope_recovery_report_path"]).read_text(encoding="utf-8")
    )
    assert report["detected_files"] == ["README.md"]
    assert report["recovered_files"] == ["README.md"]


def test_scope_violation_overrides_agent_failure_and_still_recovers(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    _write_agent_config(tmp_path, "implementation_planner")
    context = RunContext(
        run_id="run-failed-agent-001",
        workflow_name="harvest-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-failed-agent-001",
    )
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Plan work item",
        agent_id="implementation_planner",
    )

    result = BasicStepRunner(
        agent_adapter=EditingAgent(
            {"README.md": "unauthorized failed-agent change\n"},
            status=StepStatus.FAILED,
        )
    ).run(step, context)

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.SCOPE_CONFLICT
    assert (tmp_path / "README.md").read_text(encoding="utf-8") == "# Test\n"
    assert "unauthorized changes recovered" in (result.error or "")
