import json
import subprocess
from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.prompt import build_agent_prompt, stable_prefix
from harness_codex.runtime.runner import AgentRunRequest, ConfigurableCliAgentAdapter


def write_stable_context(repo: Path) -> None:
    (repo / "AGENTS.md").write_text("# AGENTS\nsource of truth\n", encoding="utf-8")
    agent_dir = repo / ".codex/agents"
    agent_dir.mkdir(parents=True)
    (agent_dir / "implementation_executor.toml").write_text(
        "\n".join(
            [
                'name = "implementation_executor"',
                'description = "executor"',
                'model = "gpt-5.5"',
                'developer_instructions = """execute carefully"""',
            ]
        ),
        encoding="utf-8",
    )
    skill_dir = repo / ".codex/skills/harness-plan-executor"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("# Skill\nexecute plan\n", encoding="utf-8")
    workflow_dir = repo / ".harness/workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "changeset-use-case-workflow.yaml").write_text(
        "version: 1\nworkflow:\n  name: changeset-use-case-workflow\n",
        encoding="utf-8",
    )
    settings_dir = repo / ".codex"
    (settings_dir / "repository-settings.md").write_text("# Settings\n", encoding="utf-8")


def context(repo: Path, *, run_id: str, work_item: str) -> RunContext:
    change_dir = repo / "docs/changes/active"
    change_dir.mkdir(parents=True, exist_ok=True)
    (change_dir / "CHG-001.md").write_text(
        f"# ChangeSet CHG-001\n\nactive item {work_item}\n",
        encoding="utf-8",
    )
    return RunContext(
        run_id=run_id,
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo,
        workdir=repo,
        run_dir=repo / ".harness/runs" / run_id,
        metadata={
            "change_set_id": "CHG-001",
            "change_set_path": "docs/changes/active/CHG-001.md",
            "active_work_item_id": work_item,
            "active_work_item_type": "use_case",
            "affected_work_items": [{"id": work_item, "type": "use_case"}],
        },
    )


def step() -> Step:
    return Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute work item",
        agent_id="implementation_executor",
        skill_id="harness-plan-executor",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
        metadata={"stage": "execution"},
    )


def agent_config() -> dict:
    return {
        "name": "implementation_executor",
        "description": "executor",
        "model": "gpt-5.5",
        "developer_instructions": "execute carefully",
    }


def test_prompt_order_places_stable_sections_before_volatile_sections(tmp_path: Path) -> None:
    write_stable_context(tmp_path)

    prompt = build_agent_prompt(
        step=step(),
        context=context(tmp_path, run_id="run-001", work_item="UC-001"),
        agent_config=agent_config(),
        agent_config_path=Path(".codex/agents/implementation_executor.toml"),
        skill_path=tmp_path / ".codex/skills/harness-plan-executor/SKILL.md",
        skill_body="# Skill\nexecute plan\n",
    )

    section_order = [
        "## 1. Runtime Instruction",
        "## 2. Repository Source of Truth",
        "## 3. Agent Instruction",
        "## 4. Skill Body",
        "## 5. Workflow Definition",
        "## 6. Repository Settings",
        "## 7. ChangeSet Summary",
        "## 8. Work Item Slice",
        "## 9. Current Execution Payload",
    ]
    indexes = [prompt.index(section) for section in section_order]
    assert indexes == sorted(indexes)
    assert "run-001" not in stable_prefix(prompt)
    assert "UC-001" not in stable_prefix(prompt)


def test_volatile_context_does_not_change_stable_prefix(tmp_path: Path) -> None:
    write_stable_context(tmp_path)

    first = build_agent_prompt(
        step=step(),
        context=context(tmp_path, run_id="run-001", work_item="UC-001"),
        agent_config=agent_config(),
        agent_config_path=Path(".codex/agents/implementation_executor.toml"),
        skill_path=tmp_path / ".codex/skills/harness-plan-executor/SKILL.md",
        skill_body="# Skill\nexecute plan\n",
    )
    second = build_agent_prompt(
        step=step(),
        context=context(tmp_path, run_id="run-999", work_item="UC-999"),
        agent_config=agent_config(),
        agent_config_path=Path(".codex/agents/implementation_executor.toml"),
        skill_path=tmp_path / ".codex/skills/harness-plan-executor/SKILL.md",
        skill_body="# Skill\nexecute plan\n",
    )

    assert stable_prefix(first) == stable_prefix(second)
    assert first != second


def test_missing_optional_context_keeps_stable_section_order(tmp_path: Path) -> None:
    write_stable_context(tmp_path)
    (tmp_path / ".codex/repository-settings.md").unlink()

    prompt = build_agent_prompt(
        step=step(),
        context=context(tmp_path, run_id="run-001", work_item="UC-001"),
        agent_config=agent_config(),
        agent_config_path=Path(".codex/agents/implementation_executor.toml"),
        skill_path=tmp_path / ".codex/skills/harness-plan-executor/SKILL.md",
        skill_body="# Skill\nexecute plan\n",
    )

    assert "### `.codex/repository-settings.md`" in prompt
    assert "<not found>" in prompt
    assert prompt.index("## 6. Repository Settings") < prompt.index("## 7. ChangeSet Summary")


def test_agent_adapter_writes_run_root_invocation_artifacts(tmp_path: Path, monkeypatch) -> None:
    write_stable_context(tmp_path)
    ctx = context(tmp_path, run_id="run-001", work_item="UC-001")
    request = AgentRunRequest(
        step=step(),
        context=ctx,
        step_dir=ctx.run_dir / "steps/execute-work-item",
        agent_config_path=tmp_path / ".codex/agents/implementation_executor.toml",
        agent_config=agent_config(),
        skill_path=tmp_path / ".codex/skills/harness-plan-executor/SKILL.md",
        skill_body="# Skill\nexecute plan\n",
    )

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="final answer",
            stderr="diagnostic",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.SUCCEEDED
    root_prompt = ctx.run_dir / "prompt-execute-work-item.md"
    step_prompt = request.step_dir / "prompt.md"
    assert root_prompt.is_file()
    assert root_prompt.read_text(encoding="utf-8") == (
        "See canonical artifact: steps/execute-work-item/prompt.md\n"
    )
    assert root_prompt.stat().st_size < step_prompt.stat().st_size
    assert (ctx.run_dir / "response-execute-work-item.json").is_file()
    assert (ctx.run_dir / "stdout-execute-work-item.log").read_text(encoding="utf-8") == (
        "See canonical artifact: steps/execute-work-item/stdout.txt\n"
    )
    assert (ctx.run_dir / "stderr-execute-work-item.log").read_text(encoding="utf-8") == (
        "See canonical artifact: steps/execute-work-item/stderr.txt\n"
    )
    assert (request.step_dir / "stdout.txt").read_text(encoding="utf-8") == "final answer"
    assert (request.step_dir / "stderr.txt").read_text(encoding="utf-8") == "diagnostic"
    usage = json.loads((ctx.run_dir / "usage-execute-work-item.json").read_text(encoding="utf-8"))
    assert usage["step_id"] == "execute-work-item"
    assert usage["work_item_id"] == "UC-001"
    assert usage["change_set_id"] == "CHG-001"
    assert usage["cached_prompt_tokens"] is None
