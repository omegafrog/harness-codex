from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.runner import (
    AgentRunRequest,
    _fallback_agent_config,
    _fallback_config_for_retry,
    _implementation_compatibility,
    _resolve_provider_command,
)


def _request(tmp_path: Path, plan_text: str = "# 계획\n") -> AgentRunRequest:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(plan_text, encoding="utf-8")
    step_dir = tmp_path / ".harness/runs/run-1/work-items/UC-001/steps/execute-work-item"
    return AgentRunRequest(
        step=Step(
            id="execute-work-item",
            kind=StepKind.AGENT,
            name="execute",
            agent_id="implementation_executor",
            inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        ),
        context=RunContext(
            run_id="run-1",
            workflow_name="workflow",
            mode=RunMode.APPLY,
            repo_root=tmp_path,
            workdir=tmp_path,
            run_dir=tmp_path / ".harness/runs/run-1/work-items/UC-001",
        ),
        step_dir=step_dir,
        agent_config_path=tmp_path / ".codex/agents/implementation_executor.toml",
        agent_config={"provider": "codex", "model": "gpt-5.4-mini"},
    )


def _model(command: list[str]) -> str:
    return command[command.index("--model") + 1]


def test_normal_implementation_overrides_mini_to_gpt54(tmp_path: Path) -> None:
    request = _request(tmp_path)

    command, metadata = _resolve_provider_command(
        request,
        tmp_path / "final.md",
        default_codex_binary="codex",
    )

    assert _model(command) == "gpt-5.4"
    assert metadata["model_override"]["reason"] == "normal_implementation"


def test_wide_refactor_overrides_to_gpt55(tmp_path: Path) -> None:
    request = _request(tmp_path, "# 계획\n\n- wide refactor runtime cleanup\n")

    command, metadata = _resolve_provider_command(
        request,
        tmp_path / "final.md",
        default_codex_binary="codex",
    )

    assert _model(command) == "gpt-5.5"
    assert metadata["model_override"]["reason"] == "wide_refactor"


def test_repeated_repair_escalates_to_gpt55(tmp_path: Path) -> None:
    request = _request(tmp_path)
    previous = (
        request.context.repo_root
        / ".harness/runs/run-old/work-items/UC-001/steps/execute-work-item"
    )
    previous.mkdir(parents=True)
    (previous / "attempt.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "attempt": 2,
                "execution_mode": "resumed",
                "compatibility": _implementation_compatibility(request),
                "provider_session_id": "session-1",
            }
        )
        + "\n",
        encoding="utf-8",
    )

    command, metadata = _resolve_provider_command(
        request,
        tmp_path / "final.md",
        default_codex_binary="codex",
    )

    assert _model(command) == "gpt-5.5"
    assert metadata["model_override"]["reason"] == "failed_verification_repair"


def test_ollama_provider_uses_declared_model(tmp_path: Path) -> None:
    request = _request(tmp_path)
    request = request.__class__(
        **{
            **request.__dict__,
            "agent_config": {"provider": "ollama", "model": "qwen3.5:4b"},
        }
    )

    command, metadata = _resolve_provider_command(
        request,
        tmp_path / "final.md",
        default_codex_binary="codex",
    )

    assert command == ["ollama", "run", "qwen3.5:4b"]
    assert metadata["provider"] == "ollama"
    assert metadata["model"] == "qwen3.5:4b"


def test_fallback_agent_config_replaces_provider_and_removes_fallback_keys() -> None:
    fallback = _fallback_agent_config(
        {
            "provider": "ollama",
            "model": "qwen3.5:4b",
            "fallback_provider": "codex",
            "fallback_model": "gpt-5.4-mini",
        }
    )

    assert fallback == {"provider": "codex", "model": "gpt-5.4-mini"}


def test_retry_uses_codex_fallback_after_quality_gate_failure(tmp_path: Path) -> None:
    request = _request(tmp_path)
    context = request.context.__class__(
        **{
            **request.context.__dict__,
            "metadata": {"runtime_retry_count": 1},
        }
    )

    config = _fallback_config_for_retry(
        {
            "provider": "ollama",
            "model": "qwen3.5:2b",
            "fallback_provider": "codex",
            "fallback_model": "gpt-5.4-mini",
            "fallback_on_retry": True,
        },
        context,
    )

    assert config["provider"] == "codex"
    assert config["model"] == "gpt-5.4-mini"
    assert config["provider_selection_reason"] == "quality_gate_retry"
