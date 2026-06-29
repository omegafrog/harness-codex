import json
from pathlib import Path

from harness_codex.runtime.materialize_execution_scope import materialize_execution_scope
from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.prompt import build_agent_prompt


def _context(repo: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        repo_root=repo,
        workdir=repo,
        run_dir=repo / ".harness/runs/run-001",
        metadata={
            "change_set_id": "CHG-001",
            "change_set_path": "docs/changes/active/CHG-001.md",
            "active_work_item_id": "UC-001",
            "active_work_item_type": "use_case",
        },
    )


def _step() -> Step:
    return Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute unchecked plan tasks",
        agent_id="implementation_executor",
        skill_id="harness-implementation-executor",
        inputs=(
            Path("docs/plans/active/UC-001/plan.md"),
            Path(".harness/runs/run-001/work-items/UC-001/execution-scope.json"),
        ),
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
        metadata={"prompt_context_profile": "execution-minimal"},
    )


def test_execution_minimal_prompt_excludes_upstream_context(tmp_path: Path) -> None:
    (tmp_path / "docs/changes/active").mkdir(parents=True)
    (tmp_path / "docs/changes/active/CHG-001.md").write_text("secret ChangeSet body", encoding="utf-8")
    (tmp_path / "AGENTS.md").write_text("secret global agent context", encoding="utf-8")
    (tmp_path / ".codex/agents").mkdir(parents=True)
    config_path = tmp_path / ".codex/agents/implementation_executor.toml"
    config_path.write_text('name = "implementation_executor"\n', encoding="utf-8")
    skill_path = tmp_path / ".codex/skills/harness-implementation-executor/SKILL.md"
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Executor skill", encoding="utf-8")

    prompt = build_agent_prompt(
        step=_step(),
        context=_context(tmp_path),
        agent_config={"name": "implementation_executor", "model": "gpt-5.5"},
        agent_config_path=config_path,
        skill_path=skill_path,
    )

    assert "## 3. Active Plan and Execution Scope" in prompt
    assert "docs/plans/active/UC-001/plan.md" in prompt
    assert "execution-scope.json" in prompt
    assert "secret ChangeSet body" not in prompt
    assert "secret global agent context" not in prompt
    assert "## 6. ChangeSet Summary" not in prompt
    assert "## 8. Retrieved Long-Term Memory" not in prompt


def test_materialized_execution_scope_is_plan_bound_not_write_authority(tmp_path: Path) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(
        "# Plan\n\n## 실행 경계\n\n- modify: src/**\n\n## 집중 검증\n\n- pytest -q\n",
        encoding="utf-8",
    )
    output = tmp_path / ".harness/runs/run-001/work-items/UC-001/execution-scope.json"

    payload = materialize_execution_scope(
        repo_root=tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
        output_path=output,
    )

    stored = json.loads(output.read_text(encoding="utf-8"))
    assert stored == payload
    assert stored["active_plan_path"] == "docs/plans/active/UC-001/plan.md"
    assert stored["runtime_write_authority"]["plan_grants_write_authority"] is False
    assert "실행 경계" in stored["plan_sections"]
    assert "집중 검증" in stored["plan_sections"]
