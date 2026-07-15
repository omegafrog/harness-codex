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


def test_workflow_agents_are_direct_root_children_for_codex_visibility() -> None:
    skill = _read(".codex/skills/harness-orchestrate-instruction/SKILL.md")
    orchestration = _read(".codex/agents/references/orchestration.md")
    main_steps = _read(".codex/workflow/main-steps.md")
    agent_rules = _read("AGENTS.md")

    assert "`/root/*` 직접 자식" in skill
    assert "step 결과를 같은 `orchestration` agent에 전달" in skill
    assert "`next_skill`" in orchestration
    assert "중첩 spawn은 금지" in main_steps
    assert "`root_spawn_request: {skill, agent_task_name, input}`" in main_steps
    assert "같은 role과 scope는 기존 직접 자식에 follow-up" in main_steps
    assert "direct `/root/*` children" in agent_rules
    assert "Do not nest workflow agents" in agent_rules
    assert "return `root_spawn_request`" in agent_rules


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
