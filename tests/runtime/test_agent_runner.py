import json
import subprocess
from pathlib import Path

from harness_codex.runtime.models import (
    RunContext,
    RunMode,
    Step,
    StepKind,
    StepStatus,
)
from harness_codex.runtime.runner import (
    AgentRunRequest,
    AgentRunResult,
    BasicStepRunner,
    CodexCliAgentAdapter,
)


class FakeAgentAdapter:
    def __init__(self, result: AgentRunResult | None = None) -> None:
        self.requests: list[AgentRunRequest] = []
        self.result = result or AgentRunResult(
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            metadata={"fake": True},
        )

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        self.requests.append(request)
        return self.result


def context(repo_root: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo_root,
        workdir=repo_root,
        run_dir=repo_root / ".harness/runs/run-001",
        metadata={
            "change_set_id": "CHG-001",
            "affected_work_items": [{"id": "UC-001", "type": "use_case"}],
        },
    )


def write_agent_config(repo_root: Path, agent_id: str = "implementation_planner") -> None:
    agents_dir = repo_root / ".codex/agents"
    agents_dir.mkdir(parents=True)
    (agents_dir / f"{agent_id}.toml").write_text(
        "\n".join(
            [
                f'name = "{agent_id}"',
                'description = "test agent"',
                'model = "gpt-5.4"',
                'model_reasoning_effort = "medium"',
                'sandbox_mode = "workspace-write"',
                'developer_instructions = """테스트 지시문"""',
            ]
        ),
        encoding="utf-8",
    )


def write_skill(repo_root: Path, skill_id: str = "harness-code-planner") -> None:
    skill_dir = repo_root / ".codex/skills" / skill_id
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                f"name: {skill_id}",
                "description: test skill",
                "---",
                "",
                "# 테스트 스킬",
                "스킬 호출 확인용 지시문",
            ]
        ),
        encoding="utf-8",
    )


def test_basic_step_runner_invokes_agent_adapter_and_writes_result(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path)
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        inputs=(Path("docs/changes/active/CHG-001.md"),),
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert result.output_path == Path(
        ".harness/runs/run-001/steps/plan-work-item/result.json"
    )
    assert fake_adapter.requests[0].agent_config["name"] == "implementation_planner"

    result_json = json.loads((tmp_path / result.output_path).read_text(encoding="utf-8"))
    assert result_json["agent_id"] == "implementation_planner"
    assert result_json["status"] == "succeeded"
    assert result_json["metadata"] == {"fake": True}


def test_basic_step_runner_records_skill_invocation_manifest(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    write_skill(tmp_path)
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        skill_id="harness-code-planner",
        inputs=(Path("docs/changes/active/CHG-001.md"),),
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    request = fake_adapter.requests[0]
    assert request.skill_path == (
        tmp_path / ".codex/skills/harness-code-planner/SKILL.md"
    )
    assert "스킬 호출 확인용 지시문" in (request.skill_body or "")

    invocation = json.loads(
        (
            tmp_path / ".harness/runs/run-001/steps/plan-work-item/invocation.json"
        ).read_text(encoding="utf-8")
    )
    assert invocation["agent_id"] == "implementation_planner"
    assert invocation["skill_id"] == "harness-code-planner"
    assert invocation["skill_path"] == ".codex/skills/harness-code-planner/SKILL.md"
    assert invocation["outputs"] == ["docs/plans/active/UC-001/plan.md"]


def test_basic_step_runner_blocks_agent_without_config(tmp_path: Path) -> None:
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "missing agent config" in (result.error or "")
    assert result.output_path == Path(
        ".harness/runs/run-001/steps/plan-work-item/result.json"
    )


def test_basic_step_runner_blocks_agent_without_skill(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter())
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        skill_id="harness-code-planner",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "missing skill config" in (result.error or "")


def test_codex_cli_agent_adapter_writes_prompt_command_and_logs(
    tmp_path: Path,
    monkeypatch,
) -> None:
    write_agent_config(tmp_path, agent_id="implementation_executor")
    request = AgentRunRequest(
        step=Step(
            id="execute-work-item",
            kind=StepKind.AGENT,
            name="Execute plan",
            agent_id="implementation_executor",
            skill_id="harness-plan-executor",
            timeout_sec=30,
        ),
        context=context(tmp_path),
        step_dir=tmp_path / ".harness/runs/run-001/steps/execute-work-item",
        agent_config_path=tmp_path / ".codex/agents/implementation_executor.toml",
        agent_config={
            "name": "implementation_executor",
            "description": "test agent",
            "model": "gpt-5.4",
            "model_reasoning_effort": "medium",
            "sandbox_mode": "workspace-write",
            "developer_instructions": "테스트 지시문",
        },
        skill_path=tmp_path / ".codex/skills/harness-plan-executor/SKILL.md",
        skill_body="# Harness Plan Executor\n스킬 본문",
    )
    request.step_dir.mkdir(parents=True)
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="agent stdout",
            stderr="agent stderr",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = CodexCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.SUCCEEDED
    command = json.loads((request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command[:2] == ["codex-test", "exec"]
    assert "--ask-for-approval" not in command
    assert 'approval_policy="never"' in command
    assert "--output-last-message" in command
    assert "--model" in command
    assert (request.step_dir / "stdout.txt").read_text(encoding="utf-8") == (
        "agent stdout"
    )
    assert (request.step_dir / "stderr.txt").read_text(encoding="utf-8") == (
        "agent stderr"
    )
    prompt = (request.step_dir / "prompt.md").read_text(encoding="utf-8")
    assert "implementation_executor" in prompt
    assert "harness-plan-executor" in prompt
    assert "스킬 본문" in prompt
    assert "테스트 지시문" in prompt
    assert calls[0][1]["timeout"] == 30


def test_codex_cli_agent_adapter_blocks_when_codex_binary_is_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = AgentRunRequest(
        step=Step(
            id="plan-work-item",
            kind=StepKind.AGENT,
            name="Create plan",
            agent_id="implementation_planner",
        ),
        context=context(tmp_path),
        step_dir=tmp_path / ".harness/runs/run-001/steps/plan-work-item",
        agent_config_path=tmp_path / ".codex/agents/implementation_planner.toml",
        agent_config={
            "name": "implementation_planner",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        raise FileNotFoundError("missing")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = CodexCliAgentAdapter(codex_binary="missing-codex").run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.error == "codex binary not found: missing-codex"
    assert (request.step_dir / "stderr.txt").read_text(encoding="utf-8") == (
        "codex binary not found: missing-codex"
    )


def test_codex_cli_agent_adapter_blocks_on_usage_limit(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = AgentRunRequest(
        step=Step(
            id="plan-work-item",
            kind=StepKind.AGENT,
            name="Create plan",
            agent_id="implementation_planner",
        ),
        context=context(tmp_path),
        step_dir=tmp_path / ".harness/runs/run-001/steps/plan-work-item",
        agent_config_path=tmp_path / ".codex/agents/implementation_planner.toml",
        agent_config={
            "name": "implementation_planner",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=1,
            stdout="",
            stderr="ERROR: You've hit your usage limit. Try again later.",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = CodexCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.exit_code == 1
    assert "usage limit" in (result.error or "")
