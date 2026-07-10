from __future__ import annotations

from pathlib import Path

from harness_codex.orchestration.session import (
    OrchestrationRunRequest,
    OrchestrationRunStatus,
    build_orchestration_prompt,
    run_orchestration,
)
from harness_codex.orchestration.session_store import OrchestrationSessionStore
from harness_codex.runtime.agent_session import AgentSessionResult



class _FakeAdapter:
    def __init__(self, result: AgentSessionResult) -> None:
        self.result = result
        self.request = None

    def run(self, request):
        self.request = request
        return self.result


def _setup_repo(tmp_path: Path) -> None:
    config_dir = tmp_path / ".codex" / "agents"
    skill_dir = tmp_path / ".codex" / "skills" / "harness-orchestrate-instruction"
    config_dir.mkdir(parents=True)
    skill_dir.mkdir(parents=True)
    (config_dir / "workflow_orchestrator.toml").write_text(
        'name = "workflow_orchestrator"\nmodel = "fake"\n\n'
        'developer_instructions = "오케스트레이션 지침"\n',
        encoding="utf-8",
    )
    (skill_dir / "SKILL.md").write_text("# 오케스트레이션 skill", encoding="utf-8")


def test_orchestration_session_preserves_instruction_and_artifacts(tmp_path: Path) -> None:
    _setup_repo(tmp_path)
    adapter = _FakeAdapter(
        AgentSessionResult(
            status="succeeded",
            termination_reason="completed",
            final_message="최종 응답",
            provider_session_id="provider-1",
            artifact_paths={
                "final_message": tmp_path / "final-message.md",
                "stdout": tmp_path / "stdout.txt",
                "stderr": tmp_path / "stderr.txt",
            },
        )
    )

    result = run_orchestration(
        OrchestrationRunRequest(repo_root=tmp_path, instruction="원문 사용자 요청"),
        session_adapter=adapter,
    )

    assert result.status is OrchestrationRunStatus.SUCCEEDED
    assert result.final_response == "최종 응답"
    assert adapter.request is not None
    assert "원문 사용자 요청" in adapter.request.prompt
    assert "selected-step" not in adapter.request.prompt
    session_dir = tmp_path / ".harness" / "orchestration" / result.session_id
    assert (session_dir / "request.json").is_file()
    assert (session_dir / "prompt.md").is_file()
    assert (session_dir / "result.json").is_file()


def test_orchestration_config_and_skill_failures_are_blocked(tmp_path: Path) -> None:
    missing_config = run_orchestration(OrchestrationRunRequest(tmp_path, "요청"))
    assert missing_config.status is OrchestrationRunStatus.BLOCKED
    assert missing_config.termination_reason == "missing_agent_config"

    _setup_repo(tmp_path)
    (tmp_path / ".codex" / "skills" / "harness-orchestrate-instruction" / "SKILL.md").unlink()
    missing_skill = run_orchestration(OrchestrationRunRequest(tmp_path, "요청"))
    assert missing_skill.status is OrchestrationRunStatus.BLOCKED
    assert missing_skill.termination_reason == "missing_skill"


def test_orchestration_replays_terminal_session_without_duplicate_provider_call(tmp_path: Path) -> None:
    _setup_repo(tmp_path)
    first_adapter = _FakeAdapter(
        AgentSessionResult(status="succeeded", termination_reason="completed", final_message="완료")
    )
    request = OrchestrationRunRequest(tmp_path, "동일 요청", session_id="session-1")

    first = run_orchestration(request, session_adapter=first_adapter)
    second = run_orchestration(request, session_adapter=_FakeAdapter(AgentSessionResult(status="failed", termination_reason="unexpected")))

    assert first.status is OrchestrationRunStatus.SUCCEEDED
    assert second.status is OrchestrationRunStatus.SUCCEEDED
    assert second.metadata["replayed"] is True
    assert (tmp_path / ".harness/orchestration/session-1/checkpoint.json").is_file()


def test_orchestration_blocks_duplicate_running_session(tmp_path: Path) -> None:
    _setup_repo(tmp_path)
    store = OrchestrationSessionStore(tmp_path, "session-1")
    lease = store.acquire()
    try:
        result = run_orchestration(
            OrchestrationRunRequest(tmp_path, "요청", session_id="session-1"),
            session_adapter=_FakeAdapter(AgentSessionResult(status="succeeded", termination_reason="completed")),
        )
    finally:
        lease.close()

    assert result.status is OrchestrationRunStatus.BLOCKED
    assert result.termination_reason == "session_busy"


def test_orchestration_prompt_contains_config_skill_and_raw_instruction(tmp_path: Path) -> None:
    prompt = build_orchestration_prompt(
        instruction="  원문  ",
        agent_config={"developer_instructions": "지침"},
        agent_config_path=Path(".codex/agents/workflow_orchestrator.toml"),
        skill_path=Path(".codex/skills/harness-orchestrate-instruction/SKILL.md"),
        skill_body="skill body",
        repo_root=tmp_path,
    )

    assert "<user_instruction>" in prompt
    assert "  원문  " in prompt
    assert "지침" in prompt
    assert "skill body" in prompt
    assert "next_step" not in prompt


def test_orchestration_prompt_assigns_subagent_call_to_orchestrator() -> None:
    prompt = build_orchestration_prompt(
        instruction="구현 요청",
        agent_config={"developer_instructions": "지침"},
        agent_config_path=Path(".codex/agents/workflow_orchestrator.toml"),
        skill_path=Path(".codex/skills/harness-orchestrate-instruction/SKILL.md"),
        skill_body="native subagent skill",
        repo_root=Path("/repo"),
    )

    assert "native subagent capability" in prompt
    assert "agent_id" in prompt
    assert "skill_id" in prompt
    assert "subagent-invocation-v1.xsd" in prompt
    assert "subagent-result-v1.xsd" in prompt
    assert "Python runtime" in prompt


def test_orchestration_assets_do_not_delegate_subagent_execution_to_runtime() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{skill}"

    assert "native subagent capability" in combined
    assert "Runtime은 subagent launcher나 workflow executor가 아니다" in combined
    assert "runtime service에 subagent 생성·선택·실행을 요청하지 않는다" in combined
    assert "selected-step-execution" not in combined
