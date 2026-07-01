import json
from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.runner import AgentRunRequest, AgentRunResult, BasicStepRunner


class MutatingAgent:
    def __init__(self, mutation) -> None:
        self._mutation = mutation
        self.calls = 0

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        self.calls += 1
        self._mutation(request.context.repo_root)
        return AgentRunResult(status=StepStatus.SUCCEEDED, exit_code=0)


def _context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-plan-state-guard",
        workflow_name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs/run-plan-state-guard",
        active_plan_path=Path("docs/plans/active/UC-100/plan.md"),
        metadata={
            "change_set_id": "CHG-100",
            "active_work_item_id": "UC-100",
            "active_plan_path": "docs/plans/active/UC-100/plan.md",
        },
    )


def _write_agent_config(repo_root: Path, agent_id: str) -> None:
    config_path = repo_root / ".codex/agents" / f"{agent_id}.toml"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(
        "\n".join(
            [
                f'name = "{agent_id}"',
                'description = "contract test agent"',
                'model = "gpt-5.4"',
                'sandbox_mode = "workspace-write"',
            ]
        )
        + "\n",
        encoding="utf-8",
    )


def _active_path(repo_root: Path) -> Path:
    return repo_root / "docs/plans/active/UC-100/plan.md"


def _completed_path(repo_root: Path) -> Path:
    return repo_root / "docs/plans/completed/UC-100/plan.md"


def _write_plan(path: Path, *, frontmatter: bool = False) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n".join(
        [
            "# Implementation Plan",
            "",
            "## 1. 구현 목표",
            "- Preserve workflow ownership",
            "",
            "## 6. 구현 계획",
            "- [ ] Execute bounded change",
            "",
            "## 10. 검증 결과",
            "- Tests: pending",
            "",
        ]
    )
    content = (
        "---\ndoc_type: plan\ncontract_version: 1\nstatus: active\n---\n" + body
        if frontmatter
        else body
    )
    path.write_text(content, encoding="utf-8")
    return content


def _agent_step(
    *,
    step_id: str = "execute-work-item",
    agent_id: str = "implementation_executor",
) -> Step:
    return Step(
        id=step_id,
        kind=StepKind.AGENT,
        name=step_id,
        agent_id=agent_id,
        outputs=(Path("docs/plans/active/UC-100/plan.md"),),
    )


def test_executor_edit_with_runtime_frontmatter_is_blocked(tmp_path: Path) -> None:
    _write_agent_config(tmp_path, "implementation_executor")
    active = _active_path(tmp_path)
    _write_plan(active, frontmatter=True)

    def update_owned_fields(_repo_root: Path) -> None:
        active.write_text(
            active.read_text(encoding="utf-8")
            .replace("- [ ] Execute bounded change", "- [x] Execute bounded change")
            .replace("- Tests: pending", "- Tests: PASS `pytest tests/runtime`"),
            encoding="utf-8",
        )

    result = BasicStepRunner(agent_adapter=MutatingAgent(update_owned_fields)).run(
        _agent_step(),
        _context(tmp_path),
    )

    assert result.status == StepStatus.BLOCKED
    assert "execution report" in (result.error or "")
    assert "- [ ] Execute bounded change" in active.read_text(encoding="utf-8")


def test_retained_completed_copy_is_blocked_and_evidence_is_structured(tmp_path: Path) -> None:
    _write_agent_config(tmp_path, "implementation_executor")
    active = _active_path(tmp_path)
    original = _write_plan(active)
    completed = _completed_path(tmp_path)

    def copy_to_completed(_repo_root: Path) -> None:
        completed.parent.mkdir(parents=True, exist_ok=True)
        completed.write_text(active.read_text(encoding="utf-8"), encoding="utf-8")

    result = BasicStepRunner(agent_adapter=MutatingAgent(copy_to_completed)).run(
        _agent_step(),
        _context(tmp_path),
    )

    evidence_path = (
        tmp_path
        / ".harness/runs/run-plan-state-guard/steps/execute-work-item/plan-transition.json"
    )
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))

    assert result.status == StepStatus.BLOCKED
    assert active.read_text(encoding="utf-8") == original
    assert not completed.exists()
    assert evidence == {
        "step_id": "execute-work-item",
        "status": "blocked",
        "active_plan_path": "docs/plans/active/UC-100/plan.md",
        "completed_plan_path": "docs/plans/completed/UC-100/plan.md",
        "error": result.error,
    }


def test_ambiguous_retry_blocks_before_the_agent_runs(tmp_path: Path) -> None:
    _write_agent_config(tmp_path, "implementation_executor")
    active = _active_path(tmp_path)
    completed = _completed_path(tmp_path)
    active_original = _write_plan(active)
    completed.parent.mkdir(parents=True, exist_ok=True)
    completed_original = "# Completed copy\n"
    completed.write_text(completed_original, encoding="utf-8")
    agent = MutatingAgent(lambda _repo_root: (_ for _ in ()).throw(AssertionError("must not run")))

    result = BasicStepRunner(agent_adapter=agent).run(_agent_step(), _context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "both active and completed plan paths exist" in (result.error or "")
    assert agent.calls == 0
    assert active.read_text(encoding="utf-8") == active_original
    assert completed.read_text(encoding="utf-8") == completed_original


def test_planner_can_create_a_missing_active_plan(tmp_path: Path) -> None:
    _write_agent_config(tmp_path, "implementation_planner")
    active = _active_path(tmp_path)

    def create_active_plan(_repo_root: Path) -> None:
        _write_plan(active)

    result = BasicStepRunner(agent_adapter=MutatingAgent(create_active_plan)).run(
        _agent_step(step_id="plan-work-item", agent_id="implementation_planner"),
        _context(tmp_path),
    )

    assert result.status == StepStatus.SUCCEEDED
    assert active.is_file()
    assert not _completed_path(tmp_path).exists()


def test_completion_step_reaches_its_own_validation_not_transition_guard(tmp_path: Path) -> None:
    active = _active_path(tmp_path)
    _write_plan(active)
    context = _context(tmp_path)
    step = Step(
        id="complete-work-item-plan",
        kind=StepKind.GIT,
        name="Complete work-item plan",
        inputs=(Path("docs/plans/active/UC-100/plan.md"),),
        outputs=(Path("docs/plans/completed/UC-100/plan.md"),),
    )

    result = BasicStepRunner().run(step, context)

    assert result.status == StepStatus.BLOCKED
    assert (result.error or "").startswith("plan completion blocked:")
    assert "plan transition blocked" not in (result.error or "")
    assert active.exists()
    assert not _completed_path(tmp_path).exists()
