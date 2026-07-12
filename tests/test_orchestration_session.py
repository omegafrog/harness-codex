from __future__ import annotations

import tomllib
from pathlib import Path

from harness_codex.orchestration.session import (
    OrchestrationRunRequest,
    OrchestrationRunStatus,
    build_orchestration_prompt,
    find_active_session_id,
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


def test_orchestration_maps_declared_workflow_blocked_status(tmp_path: Path) -> None:
    _setup_repo(tmp_path)
    adapter = _FakeAdapter(
        AgentSessionResult(
            status="succeeded",
            termination_reason="completed",
            final_message="Workflow Status: blocked\n\nexecutor timeout",
        )
    )

    result = run_orchestration(
        OrchestrationRunRequest(repo_root=tmp_path, instruction="요청"),
        session_adapter=adapter,
    )

    assert result.status is OrchestrationRunStatus.BLOCKED
    assert result.termination_reason == "workflow_blocked"
    assert result.metadata["provider_status"] == "succeeded"
    assert result.metadata["workflow_status"] == "blocked"


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


def test_active_session_lookup_reuses_matching_nonterminal_session(tmp_path: Path) -> None:
    store = OrchestrationSessionStore(tmp_path, "active-1")
    store.session_dir.mkdir(parents=True)
    (store.session_dir / "checkpoint.json").write_text(
        '{"session_id":"active-1","status":"running","request_fingerprint":"' + OrchestrationSessionStore.fingerprint(tmp_path, "요청") + '","started_at":"2026-01-01T00:00:00Z"}',
        encoding="utf-8",
    )
    assert find_active_session_id(tmp_path, "요청") == "active-1"


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
    assert "runtime_context" in prompt
    assert "runtime_dispatch" in prompt


def test_orchestration_prompt_binds_current_artifact_namespace(tmp_path: Path) -> None:
    prompt = build_orchestration_prompt(
        instruction="요청",
        session_id="session-current",
        current_artifact_run_dir=tmp_path / ".harness/runs/session-current",
        agent_config={"developer_instructions": "지침"},
        agent_config_path=Path(".codex/agents/workflow_orchestrator.toml"),
        skill_path=Path(".codex/skills/harness-orchestrate-instruction/SKILL.md"),
        skill_body="skill body",
        repo_root=tmp_path,
    )

    assert "run_id: session-current" in prompt
    assert f"run_root: {tmp_path / '.harness/runs/session-current'}" in prompt
    assert "direct shell reads" in prompt


def test_orchestration_checkpoint_persists_artifact_run_id(tmp_path: Path) -> None:
    _setup_repo(tmp_path)
    adapter = _FakeAdapter(AgentSessionResult(status="succeeded", termination_reason="completed"))

    result = run_orchestration(
        OrchestrationRunRequest(repo_root=tmp_path, instruction="요청"),
        session_adapter=adapter,
    )

    checkpoint = OrchestrationSessionStore(tmp_path, result.session_id).read_checkpoint()
    assert checkpoint["artifact_run_id"] == result.session_id
    assert (tmp_path / ".harness" / "runs" / result.session_id / "steps").is_dir()


def test_orchestration_prompt_assigns_specialist_call_to_runtime_dispatcher() -> None:
    prompt = build_orchestration_prompt(
        instruction="구현 요청",
        agent_config={"developer_instructions": "지침"},
        agent_config_path=Path(".codex/agents/workflow_orchestrator.toml"),
        skill_path=Path(".codex/skills/harness-orchestrate-instruction/SKILL.md"),
        skill_body="native subagent skill",
        repo_root=Path("/repo"),
    )

    assert "runtime_context" in prompt
    assert "runtime_dispatch" in prompt
    assert "native subagent skill" in prompt
    assert "지침" in prompt
    assert "direct shell reads" in prompt
    assert "subagent-invocation-v1.xsd" not in prompt


def test_real_orchestration_prompt_stays_within_compact_token_budget() -> None:
    root = Path(__file__).parents[1]
    config_path = root / ".codex/agents/workflow_orchestrator.toml"
    skill_path = root / ".codex/skills/harness-orchestrate-instruction/SKILL.md"
    config = tomllib.loads(config_path.read_text(encoding="utf-8"))

    prompt = build_orchestration_prompt(
        instruction="CHG-001을 이어서 완료해.",
        agent_config=config,
        agent_config_path=config_path,
        skill_path=skill_path,
        skill_body=skill_path.read_text(encoding="utf-8"),
        repo_root=root,
    )

    assert len(prompt.encode("utf-8")) <= 4_000


def test_orchestrator_agent_defines_role_and_skill_defines_sequence() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")

    assert "Responsibility:" in config
    assert "Forbidden:" in config
    assert "Delegate every selected step through runtime_dispatch" in config
    assert "execute steps" not in config
    assert "Use `.codex/skills" not in config
    assert "1. Get current" in skill
    assert "2. Select" in skill
    assert "3. Dispatch" in skill
    assert "including `execute-work-item`" in skill
    assert "every blocking finding identifies that producer" in skill
    assert "select `plan-work-item`, then review again" not in skill
    assert "4. Read returned fact" in skill
    assert "5. Repeat" in skill


def test_specialist_skills_do_not_retain_legacy_markdown_or_xml_result_contracts() -> None:
    root = Path(__file__).parents[1]
    security_skill = (root / ".codex/skills/harness-security-implementation-reviewer/SKILL.md").read_text(encoding="utf-8")
    question_agent = (root / ".codex/agents/question_orchestrator.toml").read_text(encoding="utf-8")

    assert "Return exactly one Markdown report" not in security_skill
    assert "existing v1 `subagent-result.xml`" in security_skill
    assert "matching existing v1 result" not in question_agent


def test_workflow_orchestrator_disables_irrelevant_mcp_servers() -> None:
    root = Path(__file__).parents[1]
    config = tomllib.loads((root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8"))

    from harness_codex.runtime.agent_session import _provider_config_overrides

    assert _provider_config_overrides(config) == (
        "mcp_servers.serena.enabled=false",
        "mcp_servers.playwright.enabled=false",
        "mcp_servers.graphify.enabled=false",
    )


def test_artifact_reviewer_requires_existing_result_xml_envelope() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/artifact_reviewer.toml").read_text(encoding="utf-8")
    reference = (root / ".codex/agents/references/artifact_reviewer.md").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-artifact-reviewer/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{reference}\n{skill}"

    assert "urn:harness:subagent-result:v1" in combined
    assert "Terminate without editing the reviewed artifact" in combined
    assert "<artifacts/><changes/><blockers/>" in combined


def test_implementation_executor_avoids_duplicate_full_builds() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/implementation_executor.toml").read_text(encoding="utf-8")
    reference = (root / ".codex/agents/references/implementation_executor.md").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-implementation-executor/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{reference}\n{skill}"

    assert "Run each focused verification command once, serially" in combined
    assert "urn:harness:subagent-result:v1" in combined
    assert "existing v1 result XML" in combined
    assert "execution-scope.xml" in combined


def test_specialists_use_observed_problem_resolution_before_equivalent_retry() -> None:
    root = Path(__file__).parents[1]
    protocol = (root / ".codex/agents/references/observed-problem-resolution.md").read_text(encoding="utf-8")
    executor = (root / ".codex/agents/implementation_executor.toml").read_text(encoding="utf-8")
    executor_skill = (root / ".codex/skills/harness-implementation-executor/SKILL.md").read_text(encoding="utf-8")
    planner = (root / ".codex/agents/implementation_planner.toml").read_text(encoding="utf-8")
    orchestrator_skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")

    assert "최소 증거로 원인을 분류" in protocol
    assert "시간 기반 대기 대신 bounded 상태 관측" in protocol
    assert "verification_root_cause" in executor_skill
    assert "verification_root_cause" in (root / ".codex/skills/harness-code-planner/SKILL.md").read_text(encoding="utf-8")
    assert "verification_root_cause" in orchestrator_skill
    assert "verification_observation_budget_sec" in protocol
    assert "timeout --signal=TERM --kill-after=10s <budget>s sh -c '<command>'" in protocol
    assert "do not run raw then stop later" in executor_skill
def test_orchestrator_skill_keeps_handoff_wait_and_remediation_sequence() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")

    assert 'sandbox_mode = "danger-full-access"' in config
    assert "runtime context" in skill
    assert "Runtime owns existing XML handoff" in skill


def test_planner_contract_consumes_review_remediation_without_reinterpreting_upstream_intent() -> None:
    root = Path(__file__).parents[1]
    planner = (root / ".codex/agents/implementation_planner.toml").read_text(encoding="utf-8")

    assert "Do not reinterpret approved ChangeSet or maintenance intent" in planner
    skill = (root / ".codex/skills/harness-code-planner/SKILL.md").read_text(encoding="utf-8")
    assert "For review remediation" in skill
    assert "preserve approved upstream intent" in skill
