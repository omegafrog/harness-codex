from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.prompt import build_agent_prompt
from harness_codex.runtime.runner import AgentRunRequest, _load_agent_config
from harness_codex.runtime.serena_patch import _mcp_server_allowed


def test_agent_config_loads_central_capability_manifest(tmp_path: Path) -> None:
    agents_dir = tmp_path / ".codex/agents"
    agents_dir.mkdir(parents=True)
    (agents_dir / "implementation_planner.toml").write_text(
        'name = "implementation_planner"\nprovider = "codex"\n',
        encoding="utf-8",
    )
    manifest_path = tmp_path / ".harness/agents/capabilities.toml"
    manifest_path.parent.mkdir(parents=True)
    manifest_path.write_text(
        """
[defaults.capabilities]
tool_groups = ["filesystem.read"]
mcp_servers = []

[agents.implementation_planner.capabilities]
tool_groups = ["filesystem.read", "semantic_code_search"]
mcp_servers = ["serena"]
""".strip()
        + "\n",
        encoding="utf-8",
    )

    config = _load_agent_config(agents_dir / "implementation_planner.toml")

    assert config["capability_manifest"] == ".harness/agents/capabilities.toml"
    assert config["capabilities"] == {
        "tool_groups": ["filesystem.read", "semantic_code_search"],
        "mcp_servers": ["serena"],
    }


def test_agent_prompt_includes_declared_capabilities(tmp_path: Path) -> None:
    step = Step(
        id="plan",
        kind=StepKind.AGENT,
        name="계획",
        agent_id="implementation_planner",
    )
    context = RunContext(
        run_id="run-1",
        workflow_name="test",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-1",
    )

    prompt = build_agent_prompt(
        step=step,
        context=context,
        agent_config={
            "name": "implementation_planner",
            "provider": "codex",
            "capability_manifest": ".harness/agents/capabilities.toml",
            "capabilities": {
                "tool_groups": ["filesystem.read", "semantic_code_search"],
                "mcp_servers": ["serena"],
            },
        },
        agent_config_path=Path(".codex/agents/implementation_planner.toml"),
    )

    assert "Use only the declared tool groups and MCP servers" in prompt
    assert '"capability_manifest": ".harness/agents/capabilities.toml"' in prompt
    assert '"semantic_code_search"' in prompt
    assert '"serena"' in prompt


def test_mcp_server_allowlist_respects_agent_capabilities(tmp_path: Path) -> None:
    request = AgentRunRequest(
        step=Step(
            id="plan",
            kind=StepKind.AGENT,
            name="계획",
            agent_id="implementation_planner",
        ),
        context=RunContext(
            run_id="run-1",
            workflow_name="test",
            mode=RunMode.APPLY,
            repo_root=tmp_path,
            workdir=tmp_path,
            run_dir=tmp_path / ".harness/runs/run-1",
        ),
        step_dir=tmp_path / ".harness/runs/run-1/steps/plan",
        agent_config_path=tmp_path / ".codex/agents/implementation_planner.toml",
        agent_config={"capabilities": {"mcp_servers": ["serena"]}},
    )

    assert _mcp_server_allowed(request, "serena")
    assert not _mcp_server_allowed(request, "playwright")
