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
    ConfigurableCliAgentAdapter,
)


class FakeAgentAdapter:
    def __init__(
        self,
        result: AgentRunResult | None = None,
        *,
        write_outputs: bool = True,
    ) -> None:
        self.requests: list[AgentRunRequest] = []
        self.result = result or AgentRunResult(
            status=StepStatus.SUCCEEDED,
            exit_code=0,
            metadata={"fake": True},
        )
        self.write_outputs = write_outputs

    def run(self, request: AgentRunRequest) -> AgentRunResult:
        self.requests.append(request)
        if self.write_outputs and self.result.status == StepStatus.SUCCEEDED:
            for output in request.step.outputs:
                target = request.context.repo_root / output
                if output.suffix:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("generated output\n", encoding="utf-8")
                else:
                    target.mkdir(parents=True, exist_ok=True)
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


def agent_request(tmp_path: Path, agent_config: dict) -> AgentRunRequest:
    return AgentRunRequest(
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
        agent_config=agent_config,
        skill_path=tmp_path / ".codex/skills/harness-plan-executor/SKILL.md",
        skill_body="# Harness Plan Executor\n스킬 본문",
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


def test_basic_step_runner_fails_when_agent_output_is_missing(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    runner = BasicStepRunner(agent_adapter=FakeAgentAdapter(write_outputs=False))
    step = Step(
        id="plan-work-item",
        kind=StepKind.AGENT,
        name="Create plan",
        agent_id="implementation_planner",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.FAILED
    assert result.error == "missing agent outputs: docs/plans/active/UC-001/plan.md"


def test_basic_step_runner_fails_when_required_use_case_slices_are_missing(tmp_path: Path) -> None:
    write_agent_config(tmp_path)
    adapter = FakeAgentAdapter(write_outputs=True)
    runner = BasicStepRunner(agent_adapter=adapter)
    step = Step(
        id="harvest-use-cases",
        kind=StepKind.AGENT,
        name="Derive use cases",
        agent_id="implementation_planner",
        outputs=(Path("docs/design/유스케이스.md"), Path("docs/use-cases")),
        metadata={
            "slice_outputs": {
                "root": "docs/use-cases",
                "required_per_use_case": ("use-case.md", "e2e-goal.md"),
            }
        },
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.FAILED
    assert result.error == "missing required use-case slices under docs/use-cases"


def test_basic_step_runner_blocks_implementation_executor_on_gradle_workspace_sandbox(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path, agent_id="implementation_executor")
    (tmp_path / "gradlew").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute implementation",
        agent_id="implementation_executor",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.BLOCKED
    assert "implementation environment preflight failed" in (result.error or "")
    assert "sandbox_mode is workspace-write" in (result.error or "")
    assert fake_adapter.requests == []
    preflight = json.loads(
        (tmp_path / ".harness/runs/run-001/steps/execute-work-item/preflight.json").read_text(
            encoding="utf-8"
        )
    )
    assert preflight["status"] == "blocked"
    assert preflight["gradlew_present"] is True


def test_basic_step_runner_allows_implementation_executor_with_full_access(
    tmp_path: Path,
) -> None:
    write_agent_config(tmp_path, agent_id="implementation_executor")
    config_path = tmp_path / ".codex/agents/implementation_executor.toml"
    config_path.write_text(
        config_path.read_text(encoding="utf-8").replace(
            'sandbox_mode = "workspace-write"',
            'sandbox_mode = "danger-full-access"',
        ),
        encoding="utf-8",
    )
    (tmp_path / "gradlew").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
    fake_adapter = FakeAgentAdapter()
    runner = BasicStepRunner(agent_adapter=fake_adapter)
    step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute implementation",
        agent_id="implementation_executor",
    )

    result = runner.run(step, context(tmp_path))

    assert result.status == StepStatus.SUCCEEDED
    assert len(fake_adapter.requests) == 1
    preflight = json.loads(
        (tmp_path / ".harness/runs/run-001/steps/execute-work-item/preflight.json").read_text(
            encoding="utf-8"
        )
    )
    assert preflight["status"] == "passed"


def test_configurable_agent_adapter_uses_codex_provider_by_default(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "description": "test agent",
            "model": "gpt-5.4",
            "model_reasoning_effort": "medium",
            "sandbox_mode": "workspace-write",
            "developer_instructions": "테스트 지시문",
        },
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

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["provider"] == "codex"
    command = json.loads((request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command[:3] == ["codex-test", "exec", "--skip-git-repo-check"]
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


def test_configurable_agent_adapter_uses_explicit_codex_binary(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "provider": "codex",
            "provider_binary": "codex-explicit",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-default").run(request)

    assert result.status == StepStatus.SUCCEEDED
    command = json.loads((request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command[:3] == ["codex-explicit", "exec", "--skip-git-repo-check"]


def test_configurable_agent_adapter_uses_custom_cli_provider(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "provider": "custom_cli",
            "provider_command": ["my-agent", "run", "--stdin"],
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return subprocess.CompletedProcess(
            args=args[0],
            returncode=0,
            stdout="custom final message",
            stderr="custom stderr",
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter().run(request)

    assert result.status == StepStatus.SUCCEEDED
    assert result.metadata["provider"] == "custom_cli"
    command = json.loads((request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command == ["my-agent", "run", "--stdin"]
    assert "--model" not in command
    assert "--skip-git-repo-check" not in command
    assert calls[0][1]["input"] == (request.step_dir / "prompt.md").read_text(
        encoding="utf-8"
    )
    assert (request.step_dir / "final-message.md").read_text(encoding="utf-8") == (
        "custom final message"
    )


def test_configurable_agent_adapter_blocks_custom_cli_without_command(
    tmp_path: Path,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "provider": "custom_cli",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    result = ConfigurableCliAgentAdapter().run(request)

    assert result.status == StepStatus.BLOCKED
    assert "provider_command" in (result.error or "")
    assert result.metadata["provider"] == "custom_cli"


def test_configurable_agent_adapter_blocks_unknown_provider(
    tmp_path: Path,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "provider": "other",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    result = ConfigurableCliAgentAdapter().run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.error == "unsupported agent provider: other"
    assert result.metadata["provider"] == "other"


def test_codex_cli_agent_adapter_keeps_backward_compatible_name(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_executor",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        return subprocess.CompletedProcess(args=args[0], returncode=0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = CodexCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.SUCCEEDED
    command = json.loads((request.step_dir / "command.json").read_text(encoding="utf-8"))
    assert command[:3] == ["codex-test", "exec", "--skip-git-repo-check"]


def test_configurable_agent_adapter_blocks_when_provider_binary_is_missing(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
            "name": "implementation_planner",
            "developer_instructions": "테스트 지시문",
        },
    )
    request.step_dir.mkdir(parents=True)

    def fake_run(*args, **kwargs):
        raise FileNotFoundError("missing")

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="missing-codex").run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.error == (
        "agent provider binary not found: provider=codex binary=missing-codex"
    )
    assert (request.step_dir / "stderr.txt").read_text(encoding="utf-8") == (
        "agent provider binary not found: provider=codex binary=missing-codex"
    )


def test_configurable_agent_adapter_blocks_on_usage_limit(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
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

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.exit_code == 1
    assert "usage limit" in (result.error or "")


def test_configurable_agent_adapter_reports_usage_limit_before_warnings(
    tmp_path: Path,
    monkeypatch,
) -> None:
    request = agent_request(
        tmp_path,
        {
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
            stderr=(
                "WARN plugin sync failed\n"
                "ERROR: You've hit your usage limit. Try again later.\n"
            ),
        )

    monkeypatch.setattr(subprocess, "run", fake_run)

    result = ConfigurableCliAgentAdapter(codex_binary="codex-test").run(request)

    assert result.status == StepStatus.BLOCKED
    assert result.error == "ERROR: You've hit your usage limit. Try again later."
