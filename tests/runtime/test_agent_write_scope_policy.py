import json
import subprocess
from pathlib import Path

import pytest

from harness_codex.runtime.models import (
    FailureKind,
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepStatus,
)
from harness_codex.runtime.runner import (
    AgentRunResult,
    BasicStepRunner,
)


class EditingAgentAdapter:
    def __init__(self, edits: dict[str, str]) -> None:
        self.edits = edits

    def run(self, request) -> AgentRunResult:
        for raw_path, text in self.edits.items():
            path = request.context.repo_root / raw_path
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        return AgentRunResult(
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            metadata={"fake": True},
        )


def _init_git_repo(repo_root: Path) -> None:
    subprocess.run(["git", "init"], cwd=repo_root, check=True, capture_output=True)


def _write_agent_config(repo_root: Path, agent_id: str) -> None:
    agents_dir = repo_root / ".codex/agents"
    agents_dir.mkdir(parents=True)
    (agents_dir / f"{agent_id}.toml").write_text(
        "\n".join(
            [
                f'name = "{agent_id}"',
                'description = "scope policy test agent"',
                'model = "gpt-5.4"',
                'model_reasoning_effort = "medium"',
                'sandbox_mode = "workspace-write"',
                'developer_instructions = "test"',
            ]
        ),
        encoding="utf-8",
    )


def _context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="scope-policy-test",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs/run-001",
        metadata={
            "change_set_id": "CHG-001",
            "active_work_item_id": "UC-001",
            "active_plan_path": "docs/plans/active/UC-001/plan.md",
        },
    )


_AGENT_STEPS = (
    (
        "requirements_interviewer",
        "harvest-requirements",
        "docs/design/요구사항.md",
        "docs/design/요구사항.md",
    ),
    (
        "ubiquitous_language_reviewer",
        "harvest-ubiquitous-language",
        "context.md",
        "context.md",
    ),
    (
        "harness_usecases",
        "harvest-use-cases",
        "docs/use-cases",
        "docs/use-cases/UC-001/use-case.md",
    ),
    (
        "implementation_planner",
        "plan-work-item",
        "docs/plans/active/UC-001/plan.md",
        "docs/plans/active/UC-001/plan.md",
    ),
    (
        "security_plan_reviewer",
        "secure-work-item-plan",
        "docs/plans/active/UC-001/plan.md",
        "docs/plans/active/UC-001/plan.md",
    ),
    (
        "artifact_reviewer",
        "review-work-item-plan",
        ".harness/runs/run-001/work-items/UC-001/reviews/plan-review.md",
        ".harness/runs/run-001/work-items/UC-001/reviews/plan-review.md",
    ),
    (
        "implementation_executor",
        "execute-work-item",
        "docs/plans/active/UC-001/plan.md",
        "docs/plans/active/UC-001/plan.md",
    ),
)


@pytest.mark.parametrize(
    ("agent_id", "step_id", "declared_output", "written_output"),
    _AGENT_STEPS,
)
def test_agent_write_scope_allows_each_role_declared_output(
    tmp_path: Path,
    agent_id: str,
    step_id: str,
    declared_output: str,
    written_output: str,
) -> None:
    _init_git_repo(tmp_path)
    _write_agent_config(tmp_path, agent_id)
    runner = BasicStepRunner(
        agent_adapter=EditingAgentAdapter({written_output: "declared output\n"})
    )
    step = Step(
        id=step_id,
        kind=StepKind.AGENT,
        name=step_id,
        agent_id=agent_id,
        outputs=(Path(declared_output),),
    )

    result = runner.run(step, _context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["scope_diff_status"] == "passed"
    report_path = tmp_path / result.metadata["scope_diff_report_path"]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["blocked"] == []
    assert any(row["path"] == written_output for row in report["allowed"])


@pytest.mark.parametrize(
    ("agent_id", "step_id", "declared_output", "written_output"),
    _AGENT_STEPS,
)
def test_agent_write_scope_blocks_tracked_untracked_and_ignored_files(
    tmp_path: Path,
    agent_id: str,
    step_id: str,
    declared_output: str,
    written_output: str,
) -> None:
    _init_git_repo(tmp_path)
    _write_agent_config(tmp_path, agent_id)
    (tmp_path / ".gitignore").write_text("ignored-outside.txt\n", encoding="utf-8")
    tracked = tmp_path / "tracked-outside.txt"
    tracked.write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked-outside.txt"], cwd=tmp_path, check=True)

    runner = BasicStepRunner(
        agent_adapter=EditingAgentAdapter(
            {
                written_output: "declared output\n",
                "tracked-outside.txt": "changed\n",
                "untracked-outside.txt": "unexpected\n",
                "ignored-outside.txt": "unexpected\n",
            }
        )
    )
    step = Step(
        id=step_id,
        kind=StepKind.AGENT,
        name=step_id,
        agent_id=agent_id,
        outputs=(Path(declared_output),),
    )

    result = runner.run(step, _context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.SCOPE_CONFLICT
    assert result.metadata["scope_diff_status"] == "blocked"
    report_path = tmp_path / result.metadata["scope_diff_report_path"]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert {
        "tracked-outside.txt",
        "untracked-outside.txt",
        "ignored-outside.txt",
    } <= {row["path"] for row in report["blocked"]}
    assert tracked.read_text(encoding="utf-8") == "before\n"
    assert not (tmp_path / "untracked-outside.txt").exists()
    assert not (tmp_path / "ignored-outside.txt").exists()


@pytest.mark.parametrize(
    ("agent_id", "step_id", "declared_output", "forbidden_outputs"),
    (
        (
            "requirements_interviewer",
            "harvest-requirements",
            "docs/design/요구사항.md",
            ("context.md", "docs/use-cases/UC-001/use-case.md"),
        ),
        (
            "ubiquitous_language_reviewer",
            "harvest-ubiquitous-language",
            "context.md",
            ("docs/design/요구사항.md", "docs/use-cases/UC-001/use-case.md"),
        ),
        (
            "harness_usecases",
            "harvest-use-cases",
            "docs/use-cases",
            ("docs/design/요구사항.md", "context.md"),
        ),
    ),
)
def test_harvest_agents_block_cross_stage_output_writes(
    tmp_path: Path,
    agent_id: str,
    step_id: str,
    declared_output: str,
    forbidden_outputs: tuple[str, ...],
) -> None:
    _init_git_repo(tmp_path)
    _write_agent_config(tmp_path, agent_id)
    edits = {declared_output.rstrip("/") + "/.keep": "allowed\n"}
    if Path(declared_output).suffix:
        edits = {declared_output: "allowed\n"}
    edits.update({path: "forbidden\n" for path in forbidden_outputs})
    runner = BasicStepRunner(agent_adapter=EditingAgentAdapter(edits))
    step = Step(
        id=step_id,
        kind=StepKind.AGENT,
        name=step_id,
        agent_id=agent_id,
        outputs=(Path(declared_output),),
    )

    result = runner.run(step, _context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.SCOPE_CONFLICT
    report = json.loads(
        (tmp_path / result.metadata["scope_diff_report_path"]).read_text(encoding="utf-8")
    )
    assert set(forbidden_outputs) <= {row["path"] for row in report["blocked"]}
    for path in forbidden_outputs:
        assert not (tmp_path / path).exists()


def test_requirements_agent_blocks_legacy_bootstrap_metadata_outputs(
    tmp_path: Path,
) -> None:
    _init_git_repo(tmp_path)
    _write_agent_config(tmp_path, "requirements_interviewer")
    runner = BasicStepRunner(
        agent_adapter=EditingAgentAdapter(
            {
                "docs/design/요구사항.md": "requirements\n",
                "docs/agent/context.md": "bootstrap context\n",
            }
        )
    )
    step = Step(
        id="harvest-requirements",
        kind=StepKind.AGENT,
        name="Harvest requirements",
        agent_id="requirements_interviewer",
        outputs=(Path("docs/design/요구사항.md"),),
        metadata={"bootstrap_outputs": ("docs/agent/context.md",)},
    )

    result = runner.run(step, _context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert result.failure_kind == FailureKind.SCOPE_CONFLICT
    report = json.loads(
        (tmp_path / result.metadata["scope_diff_report_path"]).read_text(encoding="utf-8")
    )
    assert {"docs/agent/context.md"} <= {row["path"] for row in report["blocked"]}
    assert not (tmp_path / "docs/agent/context.md").exists()


def test_agent_write_scope_ignores_preexisting_dirty_worktree_changes(
    tmp_path: Path,
) -> None:
    _init_git_repo(tmp_path)
    _write_agent_config(tmp_path, "implementation_planner")
    (tmp_path / "preexisting-dirty.txt").write_text("do not validate\n", encoding="utf-8")
    runner = BasicStepRunner(
        agent_adapter=EditingAgentAdapter(
            {"docs/plans/active/UC-001/plan.md": "plan\n"}
        )
    )
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Plan work item",
        agent_id="implementation_planner",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = runner.run(step, _context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    report_path = tmp_path / result.metadata["scope_diff_report_path"]
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert "preexisting-dirty.txt" not in {
        row["path"] for row in report["changed_files"]
    }
