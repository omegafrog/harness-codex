from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_orchestration_routes_feature_and_maintenance_from_intent() -> None:
    orchestration = _read(".codex/agents/references/orchestration.md")
    main_steps = _read(".codex/workflow/main-steps.md")

    for intent in ("feature", "bugfix", "refactor"):
        assert f"`{intent}`" in orchestration

    assert "`feature`는 `harness-requirements`부터 시작한다" in orchestration
    assert "`bugfix`와 `refactor`는 `MAINT-<NNN>`" in orchestration
    assert "## Feature lane" in main_steps
    assert "## Maintenance lane" in main_steps
    assert "harness-maintenance-bootstrap" in main_steps


def test_maintenance_skill_keeps_branch_rules_in_one_level_reference() -> None:
    skill = _read(".codex/skills/harness-maintenance-bootstrap/SKILL.md")
    rules = _read(
        ".codex/skills/harness-maintenance-bootstrap/references/intake-rules.md"
    )
    spec_template = _read(
        ".harness/docs/templates/maintenance/maintenance-spec.md"
    )

    assert "orchestrator가 bugfix 또는 refactor" in skill
    assert "references/intake-rules.md" in skill
    assert "## Bugfix" not in skill
    assert "## Refactor" not in skill
    assert "## Bugfix" in rules
    assert "## Refactor" in rules
    assert "feature` 재분류 blocker" in rules
    assert "## 기대 동작 근거" in spec_template
    assert "## 보존 불변 조건" in spec_template
    assert "## 구조 목표" in spec_template
    assert len(skill.encode("utf-8")) < 1_200


def test_shared_downstream_uses_single_changeset_plan() -> None:
    files = (
        ".codex/agents/references/implementation_planner.md",
        ".codex/agents/references/implementation_executor.md",
        ".codex/skills/harness-plan-document/references/write-rules.md",
        ".codex/agents/references/delivery_coordinator.md",
        ".codex/agents/references/reviewer.md",
    )

    for path in files:
        text = _read(path)
        assert "docs/plans/active/<CHG-ID>/plan.md" in text, path
        assert "docs/plans/active/<WORK-ITEM-ID>/plan.md" not in text, path
        assert "docs/changes/active/<CHG-ID>/plan.md" not in text, path


def test_planning_and_review_use_integrated_architecture() -> None:
    planner = _read(".codex/agents/references/implementation_planner.md")
    reviewer = _read(".codex/agents/references/reviewer.md")
    technical_decisions = _read(".codex/agents/references/technical_decisions.md")

    for text in (planner, reviewer, technical_decisions):
        assert "통합 DDD architecture" in text
        assert "Maintenance:" in text

    assert "verification-goal.md" in planner
    assert "architecture impact" in reviewer
    assert "docs/changes/active/<CHG-ID>/technical-decisions.md" in technical_decisions
    assert "docs/maintenance/<MAINT-ID>/technical-decisions.md" in technical_decisions


def test_orchestration_supports_explicit_and_implicit_triggering() -> None:
    skill = _read(".codex/skills/harness-orchestrate-instruction/SKILL.md")
    metadata = _read(
        ".codex/skills/harness-orchestrate-instruction/agents/openai.yaml"
    )

    assert "이 스킬이 명시적으로 선택된 경우에만" in skill
    assert "allow_implicit_invocation: true" in metadata
    assert len(skill.encode("utf-8")) < 1_200


def test_orchestration_reentry_runs_role_without_spawning_agent() -> None:
    skill = _read(".codex/skills/harness-orchestrate-instruction/SKILL.md")

    assert "현재 agent 경로가 정확히 `/orchestration`" in skill
    assert "새 orchestration agent를 만들지 않는다" in skill
    assert "`.codex/agents/orchestration.toml`" in skill
    assert "그 파일이 지시하는 참조 문서" in skill
    assert "orchestration 역할을 직접 수행한다" in skill


def test_orchestration_is_mandatory_and_fail_closed() -> None:
    skill = _read(".codex/skills/harness-orchestrate-instruction/SKILL.md")
    orchestration = _read(".codex/agents/references/orchestration.md")
    agent_rules = _read("AGENTS.md")

    assert "사용자 프롬프트 원문 전체" in skill
    assert "원문 전달 전에는 파일 읽기" in skill
    assert "`next_skill` 하나만 호출" in skill
    assert "직접 CLI·수동 실행·대체 skill로 우회하지 않는다" in skill
    assert "blocked: orchestration" in skill
    assert "요약·해석문만 있으면 `blocked: orchestration_input`" in orchestration
    assert "route 결정 전에는 하위 skill을 호출하거나 요청을 직접 수행하지 않는다" in orchestration
    assert "Skill descriptions are routing hints, not global mandates" in agent_rules
    assert "only after that skill is selected" in agent_rules


def test_orchestration_routes_app_requests_before_direct_execution() -> None:
    routes = _read(".codex/agents/references/orchestration-routes.md")
    main_steps = _read(".codex/workflow/main-steps.md")

    assert "app 실행·상태·중지·attach" in routes
    assert "`harness-runtime-run`" in routes
    assert "route 반환 전 직접 명령 실행과 대체 skill 선택은 허용하지 않는다" in routes
    assert "utility 요청은 `orchestration-routes.md`" in main_steps


def test_modified_skill_descriptions_name_their_caller() -> None:
    callers = {
        "harness-maintenance-bootstrap": "orchestrator가",
        "harness-technical-decisions": "orchestrator가",
        "harness-technical-decision-document": "technical-decisions agent가",
        "harness-technical-decision-question": "technical-decisions agent가",
        "harness-code-planner": "orchestrator가",
        "harness-plan-document": "implementation planner가",
        "harness-plan-question": "implementation planner가",
        "harness-implementation-executor": "orchestrator가",
        "harness-implementation-repair": "orchestrator가",
        "harness-delivery-coordination": "orchestrator가",
        "harness-review": "orchestrator가",
        "harness-review-document": "reviewer가",
        "harness-project-wiki": "orchestrator가",
    }

    for skill_name, caller in callers.items():
        frontmatter = _read(f".codex/skills/{skill_name}/SKILL.md").split("---", 2)[1]
        assert caller in frontmatter, skill_name


def test_document_skills_move_conditional_writes_to_references() -> None:
    skills = {
        "harness-plan-document": "Feature는",
        "harness-technical-decision-document": "Maintenance:",
        "harness-review-document": "docs/changes/active/<CHG-ID>/review.md",
    }

    for skill_name, branch_marker in skills.items():
        skill = _read(f".codex/skills/{skill_name}/SKILL.md")
        rules = _read(f".codex/skills/{skill_name}/references/write-rules.md")
        assert "references/write-rules.md" in skill
        assert branch_marker not in skill
        assert branch_marker in rules
        assert len(skill.encode("utf-8")) < 1_200


def test_implementation_gate_repair_is_orchestrator_owned_and_bounded() -> None:
    orchestration = _read(".codex/agents/references/orchestration.md")
    main_steps = _read(".codex/workflow/main-steps.md")
    skill = _read(".codex/skills/harness-implementation-repair/SKILL.md")
    metadata = _read(".codex/skills/harness-implementation-repair/agents/openai.yaml")

    assert "W6r/W7r" in main_steps
    assert "`security_review_failure`" in orchestration
    assert "`implementation_failure`" in orchestration
    for failure_class in (
        "scope_conflict",
        "upstream_design_conflict",
        "environment_blocker",
        "unclear_e2e_goal",
        "verification_goal_unclear",
        "document_delta_conflict",
    ):
        assert f"`{failure_class}`" in orchestration
    assert "최대 2회" in orchestration
    assert "같은 failure fingerprint가 반복되면 즉시" in orchestration
    assert "정렬된 실패\nrequirement·finding 식별자" in orchestration
    assert "자유 형식 오류 문장은 fingerprint 입력에서 제외" in orchestration
    assert "implementation_repairer" in skill
    assert "allow_implicit_invocation: false" in metadata
    assert len(skill.encode("utf-8")) < 1_200


def test_implementation_repair_agent_is_registered_with_scoped_capabilities() -> None:
    config = _read(".codex/config.toml")
    capabilities = _read(".harness/agents/capabilities.toml")
    agent = _read(".codex/agents/implementation_repairer.toml")

    assert "[agents.implementation_repairer]" in config
    assert 'config_file = "agents/implementation_repairer.toml"' in config
    assert "[agents.implementation_repairer.capabilities]" in capabilities
    assert '"filesystem.write.scoped"' in capabilities.split(
        "[agents.implementation_repairer.capabilities]", 1
    )[1].split("[agents.", 1)[0]
    assert "Do not plan, route, review, widen scope" in agent


def test_repair_rechecks_the_earliest_invalidated_gate() -> None:
    orchestration = _read(".codex/agents/references/orchestration.md")
    repairer = _read(".codex/agents/references/implementation_repairer.md")
    reviewer = _read(".codex/agents/references/reviewer.md")

    assert "W6 repair는 W6" in orchestration
    assert "선택된 security control을 무효화하면 W6" in orchestration
    assert "그 외 W7부터 재검증" in orchestration
    assert "security_controls_invalidated" in repairer
    assert "다음 gate, retry 또는\nupstream route는 선택하지 않는다" in repairer
    assert "다음 step,\nretry target 또는 remediation route는 선택하지 않는다" in reviewer


def test_security_reviewer_returns_verdict_without_repair_routing() -> None:
    skill = _read(".codex/skills/harness-security-implementation-reviewer/SKILL.md")
    agent = _read(".codex/agents/security_implementation_reviewer.toml")

    for text in (skill, agent):
        assert "security_review_failure" in text
        assert "evidence fingerprint" in text
        assert "retry target" in text
