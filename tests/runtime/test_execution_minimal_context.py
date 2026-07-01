import json
from pathlib import Path

import pytest

from harness_codex.runtime.materialize_execution_scope import (
    ExecutionPlanContractError,
    materialize_execution_scope,
)
from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.prompt import build_agent_prompt


def _context(repo: Path) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo,
        workdir=repo,
        run_dir=repo / ".harness/runs/run-001",
        metadata={
            "change_set_id": "CHG-001",
            "change_set_path": "docs/changes/active/CHG-001.md",
            "active_work_item_id": "UC-001",
            "active_work_item_type": "use_case",
        },
    )


def _step() -> Step:
    return Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute unchecked plan tasks",
        agent_id="implementation_executor",
        skill_id="harness-implementation-executor",
        inputs=(
            Path("docs/plans/active/UC-001/plan.md"),
            Path(".harness/runs/run-001/work-items/UC-001/execution-scope.json"),
        ),
        outputs=(Path(".harness/runs/run-001/work-items/UC-001/execution-report.json"),),
        metadata={"prompt_context_profile": "execution-minimal"},
    )


def _executor_ready_plan() -> str:
    return """# Plan

## 실행 경계

- 대상 bounded context/module: orders
- 대상 aggregate root: Order
- 수정 허용 경로: src/orders/**
- 수정 금지 경로: src/legacy/**

## 패키지 및 의존성 계약

- 생성 클래스: orders.domain.Order under domain
- 허용 의존성 방향: ui -> application -> domain
- bootstrap wiring: orders bootstrap configuration

## 도메인 구현 계약

- Aggregate invariant: quantity must be positive
- 상태 전이: draft -> confirmed
- Entity/Value Object 검증: Quantity validates positive values
- Domain Event: OrderConfirmed emitted after confirmation
- Transaction, idempotency, concurrency: optimistic lock is required

## 외부 계약 읽기 허용 목록

- event schema -> src/events/OrderConfirmed.java

## 작업 체크리스트

- [ ] src/orders/domain/Order.java: enforce confirmation invariant
- [ ] src/orders/domain/OrderTest.java: verify draft to confirmed transition

## 집중 검증

- [ ] Focused tests: ./gradlew :orders:test -> PASS
- 중단 조건: event schema is unavailable
"""


def test_execution_minimal_prompt_excludes_upstream_context(tmp_path: Path) -> None:
    (tmp_path / "docs/changes/active").mkdir(parents=True)
    (tmp_path / "docs/changes/active/CHG-001.md").write_text("secret ChangeSet body", encoding="utf-8")
    (tmp_path / "AGENTS.md").write_text("secret global agent context", encoding="utf-8")
    (tmp_path / ".codex/agents").mkdir(parents=True)
    config_path = tmp_path / ".codex/agents/implementation_executor.toml"
    config_path.write_text('name = "implementation_executor"\n', encoding="utf-8")
    skill_path = tmp_path / ".codex/skills/harness-implementation-executor/SKILL.md"
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Executor skill", encoding="utf-8")

    prompt = build_agent_prompt(
        step=_step(),
        context=_context(tmp_path),
        agent_config={"name": "implementation_executor", "model": "gpt-5.5"},
        agent_config_path=config_path,
        skill_path=skill_path,
    )

    assert "## 3. Active Plan and Execution Scope" in prompt
    assert "docs/plans/active/UC-001/plan.md" in prompt
    assert "execution-scope.json" in prompt
    assert "secret ChangeSet body" not in prompt
    assert "secret global agent context" not in prompt
    assert "## 6. ChangeSet Summary" not in prompt
    assert "## 4. Historical Memory and Evolution Context" in prompt
    assert "No matching verified memory." in prompt
    assert "No accepted evolution guidance." in prompt


def test_execution_minimal_prompt_includes_reference_only_memory_and_evolution(
    tmp_path: Path,
) -> None:
    (tmp_path / ".codex/agents").mkdir(parents=True)
    config_path = tmp_path / ".codex/agents/implementation_executor.toml"
    config_path.write_text('name = "implementation_executor"\n', encoding="utf-8")
    skill_path = tmp_path / ".codex/skills/harness-implementation-executor/SKILL.md"
    skill_path.parent.mkdir(parents=True)
    skill_path.write_text("# Executor skill", encoding="utf-8")
    memory_path = tmp_path / "docs/memory/review-learning/MEM-20260629-001.md"
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    memory_path.write_text(
        "\n".join(
            [
                "---",
                "memory_id: MEM-20260629-001",
                "kind: review_learning",
                "source_path: docs/changes/completed/CHG-000.md",
                "change_set_id: CHG-000",
                "work_item_id: UC-000",
                "status: verified",
                "repository_revision: historical-revision",
                "tags:",
                "  - evolution",
                "  - use_case",
                "applies_to:",
                "  - execute",
                "created_at: '2026-06-29'",
                "---",
                "",
                "Keep completed checklist marks when rewriting implementation plans.",
            ]
        ),
        encoding="utf-8",
    )
    accepted_path = tmp_path / ".harness/evolution/accepted/EVO-20260629-001.md"
    accepted_path.parent.mkdir(parents=True, exist_ok=True)
    accepted_path.write_text(
        "\n".join(
            [
                "# Evolution Proposal: EVO-20260629-001",
                "",
                "## Intent Feedback",
                "",
                "- Step `execute-work-item` (approval, workflow_stage): correction. Reusable rule: Preserve checked plan tasks during implementation retries.",
                "",
                "## Proposed Mutable Component Change",
                "",
                "- Classification: `eligible`",
                "- Component: `runner-policy`",
                "- Target path: `.harness/evolution/components/runner-policy/retry.md`",
                "",
                "## Reviewer Decision",
                "",
                "- Reviewer decision: `accepted`",
            ]
        ),
        encoding="utf-8",
    )

    prompt = build_agent_prompt(
        step=_step(),
        context=_context(tmp_path),
        agent_config={"name": "implementation_executor", "model": "gpt-5.5"},
        agent_config_path=config_path,
        skill_path=skill_path,
    )

    assert "Active plan and execution-scope remain the only executable implementation instructions." in prompt
    assert "MEM-20260629-001" in prompt
    assert "Keep completed checklist marks" in prompt
    assert "EVO-20260629-001.md" in prompt
    assert "Preserve checked plan tasks during implementation retries." in prompt
    assert "- Reference-only: `true`" in prompt


def test_materialized_execution_scope_is_plan_bound_not_write_authority(tmp_path: Path) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(_executor_ready_plan(), encoding="utf-8")
    output = tmp_path / ".harness/runs/run-001/work-items/UC-001/execution-scope.json"

    payload = materialize_execution_scope(
        repo_root=tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
        output_path=output,
        enforce_full_contract=True,
    )

    stored = json.loads(output.read_text(encoding="utf-8"))
    assert stored == payload
    assert stored["active_plan_path"] == "docs/plans/active/UC-001/plan.md"
    assert stored["plan_fingerprint"] == f"sha256:{stored['plan_sha256']}"
    assert stored["execution_report_path"] == ".harness/runs/run-001/work-items/UC-001/execution-report.json"
    assert stored["execution_report_contract"]["required_plan_fingerprint"] == stored["plan_fingerprint"]
    assert stored["execution_report_contract"]["required_path"] == stored["execution_report_path"]
    assert stored["runtime_write_authority"]["plan_grants_write_authority"] is False
    assert stored["runtime_write_authority"]["plan_file_lists_are_exhaustive"] is False
    assert "build files" in stored["runtime_write_authority"]["product_implementation_categories"]
    assert stored["plan_contract"]["status"] == "valid"
    assert "domain_implementation_contract" in stored["plan_contract"]["required_sections"]
    assert "실행 경계" in stored["plan_sections"]
    assert "집중 검증" in stored["plan_sections"]


def test_execution_scope_allows_non_blacklisted_angle_tokens_in_verification_commands(tmp_path: Path) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(
        _executor_ready_plan().replace(
            "- [ ] Focused tests: ./gradlew :orders:test -> PASS",
            '- [ ] E2E: curl -H "Authorization: Bearer <USER_TOKEN>" '
            "http://127.0.0.1/orders/<OWNED_ID>?mode=<runtime-mode> -> PASS",
        ),
        encoding="utf-8",
    )

    payload = materialize_execution_scope(
        repo_root=tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
        output_path=tmp_path / "scope.json",
        enforce_full_contract=True,
    )

    assert payload["plan_contract"]["status"] == "valid"


def test_execution_scope_rejects_template_placeholders_when_enforced(tmp_path: Path) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(
        _executor_ready_plan().replace(
            "- [ ] Focused tests: ./gradlew :orders:test -> PASS",
            "- [ ] Focused tests: `<command>` -> `<success criteria>`",
        ),
        encoding="utf-8",
    )

    with pytest.raises(ExecutionPlanContractError, match="집중 검증"):
        materialize_execution_scope(
            repo_root=tmp_path,
            change_set_id="CHG-001",
            work_item_id="UC-001",
            plan_path=Path("docs/plans/active/UC-001/plan.md"),
            output_path=tmp_path / "scope.json",
            enforce_full_contract=True,
        )


def test_execution_scope_rejects_missing_domain_handoff_when_enforced(tmp_path: Path) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("# Plan\n\n## 실행 경계\n\n- scope: orders\n", encoding="utf-8")

    with pytest.raises(ExecutionPlanContractError, match="도메인 구현 계약"):
        materialize_execution_scope(
            repo_root=tmp_path,
            change_set_id="CHG-001",
            work_item_id="UC-001",
            plan_path=Path("docs/plans/active/UC-001/plan.md"),
            output_path=tmp_path / "scope.json",
            enforce_full_contract=True,
        )
