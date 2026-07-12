from __future__ import annotations

import tomllib
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
    assert f"changeset_workflow_path: {tmp_path / '.harness/workflows/changeset-use-case-workflow.yaml'}" in prompt
    assert "workflow YAML을 검색하거나 discovery하지 않는다" in prompt
    assert "next_step" not in prompt


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

    assert "current_artifact_run_id: session-current" in prompt
    assert f"current_artifact_run_dir: {tmp_path / '.harness/runs/session-current'}" in prompt
    assert "새 orchestration session은 current_artifact_run_id" in prompt
    assert "오래된 approved/rejected artifact" in prompt
    assert "stale로 분류하고 producer step" in prompt
    assert "이 root 밖의 `.harness/runs/**` 파일은 읽거나 검색하지 않는다" in prompt


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
    assert "절대 `.harness/runs` 전체를 검색하지 말고" in prompt
    assert "`find .harness/runs`" in prompt
    assert "declared command를 그대로 한 번 실행" in prompt
    assert "active plan 재개 hot path" in prompt


def test_orchestration_assets_do_not_delegate_subagent_execution_to_runtime() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{skill}"

    assert "native subagent capability" in combined
    assert "Runtime은 subagent launcher나 workflow executor가 아니다" in combined
    assert "runtime service에 subagent 생성·선택·실행을 요청하지 않는다" in combined
    assert "selected-step-execution" not in combined


def test_workflow_orchestrator_disables_irrelevant_mcp_servers() -> None:
    root = Path(__file__).parents[1]
    config = tomllib.loads(
        (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    )

    assert config["provider_config_overrides"] == [
        "mcp_servers.serena.enabled=false",
        "mcp_servers.playwright.enabled=false",
        "mcp_servers.graphify.enabled=false",
    ]


def test_orchestrator_routes_legacy_impact_tags_to_bounded_changeset_migration() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")
    bootstrap = (root / ".codex/skills/harness-change-set-bootstrap/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{skill}\n{bootstrap}"

    assert "legacy-impact-tag-migration" in combined
    assert "do not terminal-block" in combined
    assert "documentation`, `source-code`" in combined


def test_artifact_reviewer_requires_existing_result_xml_envelope() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/artifact_reviewer.toml").read_text(encoding="utf-8")
    reference = (root / ".codex/agents/references/artifact_reviewer.md").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-artifact-reviewer/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{reference}\n{skill}"

    assert "urn:harness:subagent-result:v1" in combined
    assert "never write a plain `<review>`" in combined
    assert "<artifacts/><changes/><blockers/>" in combined


def test_implementation_executor_avoids_duplicate_full_builds() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/implementation_executor.toml").read_text(encoding="utf-8")
    reference = (root / ".codex/agents/references/implementation_executor.md").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-implementation-executor/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{reference}\n{skill}"

    assert "runs at most once per executor attempt" in combined
    assert "Run Gradle/Maven/npm verification serially" in combined
    assert "urn:harness:subagent-result:v1" in combined
    assert "Never use legacy `<status>`" in combined
    assert "execution-scope.xml" in combined


def test_specialists_use_observed_problem_resolution_before_equivalent_retry() -> None:
    root = Path(__file__).parents[1]
    protocol = (root / ".codex/agents/references/observed-problem-resolution.md").read_text(encoding="utf-8")
    executor = (root / ".codex/agents/implementation_executor.toml").read_text(encoding="utf-8")
    planner = (root / ".codex/agents/implementation_planner.toml").read_text(encoding="utf-8")
    orchestrator = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")

    assert "최소 증거로 원인을 분류" in protocol
    assert "시간 기반 대기 대신 bounded 상태 관측" in protocol
    assert "observed-problem-resolution.md" in executor
    assert "observed-problem-resolution.md" in planner
    assert "observed-problem-resolution.md" in orchestrator
    assert "rather than classifying it as an environment blocker" in orchestrator
    assert "verification_root_cause" in executor
    assert "verification_observation_budget_sec" in protocol
    assert "<inputArtifacts>" in orchestrator


def test_executor_result_path_is_not_execution_report_path() -> None:
    root = Path(__file__).parents[1]
    orchestrator = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    executor = (root / ".codex/agents/implementation_executor.toml").read_text(encoding="utf-8")

    assert "execution-scope 안의 `execution_report_path`는 specialist 출력이 아니라" in orchestrator
    assert "executor는 그 파일을 쓰지 않고" in executor


def test_orchestrator_treats_empty_native_wait_state_as_nonterminal() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")

    assert "empty or missing `agents_states` is non-terminal" in config
    assert "Empty or missing `agents_states`" in skill


def test_orchestrator_uses_xml_state_and_ignores_legacy_worktree_state() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{skill}"

    assert ".harness/state/changesets/<CHG-ID>/state.xml" in combined
    assert "state.json" in combined
    assert ".-harness-worktrees/**" in combined
    assert ".harness/runs/<RUN-ID>/state.json" in config


def test_orchestrator_runs_declared_validator_before_executor() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{skill}"

    assert "kind: validator" in combined
    assert "materialize-execution-scope" in combined
    assert "execution-scope.xml" in combined
    assert "missing `execution-scope.xml` is a validator execution failure" in combined


def test_orchestrator_native_spawn_payload_uses_one_plain_message() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{skill}"

    assert '"agent_type": "<selected agent_id>"' in combined
    assert '"message": "<handoff packet' in combined
    assert "`message`와 `items`를 함께 보내지 않는다" in combined
    assert "`fork_context: true`를 사용할 때는 `agent_type`" in combined


def test_orchestrator_uses_step_scoped_handoffs_and_bounded_specialist_wait() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{skill}"

    assert ".harness/runs/<RUN-ID>/steps/<STEP-ID>/subagent-invocation.xml" in combined
    assert ".harness/runs/<RUN-ID>/steps/<STEP-ID>/subagent-result.xml" in combined
    assert "Never share or overwrite handoff files across steps" in combined
    assert "provider timeout/blocker" in combined
    assert "orphan provider" in combined
    assert "fixed 60- or 120-second timeout" in combined
    assert "implementation executor `1200` seconds" in combined
    assert "maintenance bootstrap `300` seconds" in combined
    assert "planner/reviewer `180` seconds" in combined
    assert "result from another `step_id`" in combined


def test_orchestrator_routes_plan_review_rejection_to_bounded_plan_remediation() -> None:
    root = Path(__file__).parents[1]
    config = (root / ".codex/agents/workflow_orchestrator.toml").read_text(encoding="utf-8")
    skill = (root / ".codex/skills/harness-orchestrate-instruction/SKILL.md").read_text(encoding="utf-8")
    combined = f"{config}\n{skill}"

    assert "Review Status: rejected" in combined
    assert "plan-work-item" in combined
    assert "review-work-item-plan" in combined
    assert "canonical upstream direction" in combined
    assert "Do not materialize execution scope" in combined
    assert "upstream artifacts themselves conflict" in combined
    assert "single user question" in combined


def test_planner_contract_consumes_review_remediation_without_reinterpreting_upstream_intent() -> None:
    root = Path(__file__).parents[1]
    planner = (root / ".codex/agents/implementation_planner.toml").read_text(encoding="utf-8")

    assert "review remediation" in planner
    assert "upstream canonical artifacts" in planner
    assert "preserve approved ChangeSet and maintenance intent" in planner
    assert "unrelated user answers" in planner
