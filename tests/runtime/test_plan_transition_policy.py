from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.runner import AgentRunRequest, AgentRunResult, BasicStepRunner


class MutatingAgent:
    def __init__(self, mutation) -> None:
        self._mutation = mutation

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        self._mutation(request.context.repo_root)
        return AgentRunResult(status=StepStatus.SUCCEEDED, exit_code=0)


def _write_agent_config(repo_root: Path, agent_id: str) -> None:
    agents_dir = repo_root / ".codex/agents"
    agents_dir.mkdir(parents=True, exist_ok=True)
    (agents_dir / f"{agent_id}.toml").write_text(
        "\n".join(
            [
                f'name = "{agent_id}"',
                'description = "test agent"',
                'model = "gpt-5.4"',
                'sandbox_mode = "workspace-write"',
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs/run-001",
        active_plan_path=Path("docs/plans/active/UC-001/plan.md"),
        metadata={
            "change_set_id": "CHG-001",
            "active_work_item_id": "UC-001",
            "active_plan_path": "docs/plans/active/UC-001/plan.md",
        },
    )


def _step(agent_id: str = "implementation_executor") -> Step:
    return Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute work item",
        agent_id=agent_id,
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )


def _active_plan(repo_root: Path) -> Path:
    path = repo_root / "docs/plans/active/UC-001/plan.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            [
                "# Implementation Plan",
                "",
                "## 1. 구현 목표",
                "- Original goal",
                "",
                "## 6. 구현 계획",
                "- [ ] Implement the bounded change",
                "",
                "## 10. 검증 결과",
                "- Tests: pending",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return path


def test_runtime_blocks_and_restores_premature_plan_move(tmp_path: Path) -> None:
    _write_agent_config(tmp_path, "implementation_executor")
    active = _active_plan(tmp_path)
    original = active.read_text(encoding="utf-8")
    completed = tmp_path / "docs/plans/completed/UC-001/plan.md"

    def move_plan(repo_root: Path) -> None:
        completed.parent.mkdir(parents=True, exist_ok=True)
        completed.write_text(active.read_text(encoding="utf-8"), encoding="utf-8")
        active.unlink()

    result = BasicStepRunner(agent_adapter=MutatingAgent(move_plan)).run(
        _step(),
        _context(tmp_path),
    )

    assert result.status == StepStatus.BLOCKED
    assert "only `complete-work-item-plan` may move a plan" in (result.error or "")
    assert active.read_text(encoding="utf-8") == original
    assert not completed.exists()
    assert (tmp_path / ".harness/runs/run-001/steps/execute-work-item/plan-transition.json").is_file()


def test_executor_may_tick_existing_checkboxes_and_record_verification_results(
    tmp_path: Path,
) -> None:
    _write_agent_config(tmp_path, "implementation_executor")
    active = _active_plan(tmp_path)

    def update_executor_owned_fields(_repo_root: Path) -> None:
        active.write_text(
            active.read_text(encoding="utf-8")
            .replace("- [ ] Implement the bounded change", "- [x] Implement the bounded change")
            .replace("- Tests: pending", "- Tests: PASS `python -m pytest tests/runtime`"),
            encoding="utf-8",
        )

    result = BasicStepRunner(
        agent_adapter=MutatingAgent(update_executor_owned_fields)
    ).run(_step(), _context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED


def test_runtime_blocks_and_restores_executor_mutation_outside_owned_fields(
    tmp_path: Path,
) -> None:
    _write_agent_config(tmp_path, "implementation_executor")
    active = _active_plan(tmp_path)
    original = active.read_text(encoding="utf-8")

    def rewrite_goal(_repo_root: Path) -> None:
        active.write_text(
            active.read_text(encoding="utf-8").replace("Original goal", "Changed goal"),
            encoding="utf-8",
        )

    result = BasicStepRunner(agent_adapter=MutatingAgent(rewrite_goal)).run(
        _step(),
        _context(tmp_path),
    )

    assert result.status == StepStatus.BLOCKED
    assert "executor plan mutation blocked" in (result.error or "")
    assert active.read_text(encoding="utf-8") == original


def test_retry_recovers_completed_plan_back_to_active_location(tmp_path: Path) -> None:
    _write_agent_config(tmp_path, "implementation_planner")
    completed = tmp_path / "docs/plans/completed/UC-001/plan.md"
    completed.parent.mkdir(parents=True, exist_ok=True)
    completed.write_text("# Recovered plan\n", encoding="utf-8")
    active = tmp_path / "docs/plans/active/UC-001/plan.md"
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = BasicStepRunner(agent_adapter=MutatingAgent(lambda _repo_root: None)).run(
        step,
        _context(tmp_path),
    )

    assert result.status == StepStatus.SUCCEEDED
    assert active.read_text(encoding="utf-8") == "# Recovered plan\n"
    assert not completed.exists()
