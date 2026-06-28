import subprocess
import tomllib
from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.prompt import build_agent_prompt
from harness_codex.runtime.runner import AgentRunRequest, ConfigurableCliAgentAdapter
from harness_codex.runtime.workflows import load_named_workflow


REPO_ROOT = Path(__file__).parents[2]
EXECUTOR_AGENT = Path(".codex/agents/implementation_executor.toml")
EXECUTOR_REFERENCE = Path(".codex/agents/references/implementation_executor.md")
EXECUTOR_SUPPORT_REFERENCES = (
    Path(".codex/agents/references/implementation-executor-execution-rules.md"),
    Path(".codex/agents/references/implementation-executor-completion-report.md"),
)
EXECUTOR_SKILL = Path(".codex/skills/harness-implementation-executor/SKILL.md")
LEGACY_PLAN_EXECUTOR_SKILL = Path(".codex/skills/harness-plan-executor/SKILL.md")


def _write_executor_fixture(repo: Path) -> tuple[RunContext, Step, dict]:
    for relative_path in (
        EXECUTOR_AGENT,
        EXECUTOR_REFERENCE,
        EXECUTOR_SKILL,
        Path(".harness/workflows/changeset-use-case-workflow.yaml"),
        Path(".codex/repository-settings.md"),
    ):
        source = REPO_ROOT / relative_path
        target = repo / relative_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")

    (repo / "AGENTS.md").write_text("# AGENTS\n", encoding="utf-8")
    plan_path = repo / "docs/plans/active/UC-373/plan.md"
    plan_path.parent.mkdir(parents=True, exist_ok=True)
    plan_path.write_text("# Plan\n\n- [ ] Implement bounded task\n", encoding="utf-8")
    change_set_path = repo / "docs/changes/active/CHG-373.md"
    change_set_path.parent.mkdir(parents=True, exist_ok=True)
    change_set_path.write_text("# ChangeSet\n", encoding="utf-8")

    context = RunContext(
        run_id="run-373",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo,
        workdir=repo,
        run_dir=repo / ".harness/runs/run-373",
        metadata={
            "change_set_id": "CHG-373",
            "change_set_path": "docs/changes/active/CHG-373.md",
            "active_work_item_id": "UC-373",
            "active_work_item_type": "use_case",
            "active_plan_path": "docs/plans/active/UC-373/plan.md",
        },
    )
    step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute unchecked plan tasks",
        agent_id="implementation_executor",
        skill_id="harness-implementation-executor",
        inputs=(Path("docs/plans/active/UC-373/plan.md"),),
        outputs=(Path("docs/plans/active/UC-373/plan.md"),),
        metadata={"stage": "implementation", "scope": "work_item"},
    )
    config = tomllib.loads((repo / EXECUTOR_AGENT).read_text(encoding="utf-8"))
    return context, step, config


def test_executor_prompt_and_skill_are_implementation_only() -> None:
    config = (REPO_ROOT / EXECUTOR_AGENT).read_text(encoding="utf-8")
    reference = (REPO_ROOT / EXECUTOR_REFERENCE).read_text(encoding="utf-8")
    support_references = [
        (REPO_ROOT / path).read_text(encoding="utf-8") for path in EXECUTOR_SUPPORT_REFERENCES
    ]
    focused_skill = (REPO_ROOT / EXECUTOR_SKILL).read_text(encoding="utf-8")
    legacy_skill = (REPO_ROOT / LEGACY_PLAN_EXECUTOR_SKILL).read_text(encoding="utf-8")

    assert ".codex/skills/harness-implementation-executor/SKILL.md" in config
    assert ".codex/skills/harness-implementation-executor/SKILL.md" in reference
    assert "harness-plan-executor" not in config
    assert "harness-plan-executor" not in reference
    assert all("harness-plan-executor" not in text for text in support_references)
    for text in (config, reference, focused_skill):
        assert "Do not invoke another agent" in text
        assert "Do not move" in text
        assert "completed resume state" in text
        assert "first remaining `- [ ]` checkbox" in text
    assert "classify final verification" in config
    assert "Do not perform or classify final verification" in reference
    assert "Do not perform or classify final verification" in focused_skill
    assert "Runtime owns orchestration" in focused_skill
    assert "must not be supplied to `implementation_executor`" in legacy_skill


def test_runtime_uses_focused_skill_and_keeps_finalization_boundaries() -> None:
    workflow = load_named_workflow("changeset-use-case-workflow")

    execute_step = workflow.step_by_id("execute-work-item")
    assert execute_step.agent_id == "implementation_executor"
    assert execute_step.skill_id == "harness-implementation-executor"
    assert workflow.step_by_id("verify-work-item").needs == ("execute-work-item",)
    assert workflow.step_by_id("classify-verification-result").kind == StepKind.DECISION
    assert workflow.step_by_id("remediate-work-item").metadata["loop_target"] == "execute-work-item"
    assert workflow.step_by_id("complete-work-item-plan").kind == StepKind.GIT


def test_implementation_step_uses_one_provider_invocation_without_nested_skill(
    tmp_path: Path, monkeypatch
) -> None:
    context, step, config = _write_executor_fixture(tmp_path)
    request = AgentRunRequest(
        step=step,
        context=context,
        step_dir=context.run_dir / "steps/execute-work-item",
        agent_config_path=tmp_path / EXECUTOR_AGENT,
        agent_config=config,
        skill_path=tmp_path / EXECUTOR_SKILL,
    )
    commands: list[list[str]] = []

    def fake_run(command, **kwargs):
        commands.append(command)
        return subprocess.CompletedProcess(
            args=command,
            returncode=0,
            stdout="implementation result",
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)
    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.SUCCEEDED
    assert len(commands) == 1
    command = commands[0]
    expected_core = [
        "codex-test",
        "exec",
        "--skip-git-repo-check",
        "-c",
        'approval_policy="never"',
        "--json",
        "--output-last-message",
        str(request.step_dir / "final-message.md"),
        "--cd",
        str(tmp_path),
        "--model",
        "gpt-5.4",
        "-c",
        'model_reasoning_effort="medium"',
        "--sandbox",
        "danger-full-access",
    ]
    cursor = 0
    for argument in expected_core:
        cursor = command.index(argument, cursor) + 1
    assert command[-1] == "-"
    prompt = (request.step_dir / "prompt.md").read_text(encoding="utf-8")
    assert "harness-implementation-executor" in prompt
    assert "harness-plan-executor" not in prompt


def test_composed_executor_prompt_uses_focused_contract(tmp_path: Path) -> None:
    context, step, config = _write_executor_fixture(tmp_path)

    prompt = build_agent_prompt(
        step=step,
        context=context,
        agent_config=config,
        agent_config_path=EXECUTOR_AGENT,
        skill_path=tmp_path / EXECUTOR_SKILL,
    )

    assert ".codex/skills/harness-implementation-executor/SKILL.md" in prompt
    assert "harness-plan-executor" not in prompt
