from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_intent_requires_positive_product_semantics_evidence() -> None:
    declarations = _read(".codex/workflow/declaration-contracts.md")
    orchestration = _read(".codex/agents/references/orchestration.md")

    assert "제품 의미·사업 정책·권한·상태 전이·공개 계약 변경" in declarations
    assert "사용자가 결과를 관찰할 수 있다는 사실" in declarations
    assert "feature의 충분조건이 아니다" in declarations
    assert "feature로 추측하지 않고" in orchestration


def test_target_participation_separates_verification_from_delivery() -> None:
    declarations = _read(".codex/workflow/declaration-contracts.md")
    delivery = _read(".codex/agents/references/delivery_coordinator.md")

    for column in ("Mutation", "Verification", "Delivery", "Failure report", "Blocking"):
        assert column in declarations
    assert "Delivery: none" in delivery
    assert "bootstrap·선행 Issue·구현 전달을 수행하지 않는다" in delivery


def test_executor_batches_and_reviewer_reuses_valid_evidence() -> None:
    executor = _read(".codex/agents/references/implementation_executor.md")
    reviewer = _read(".codex/agents/references/reviewer.md")
    plan = _read(".codex/skills/harness-plan-document/references/template.md")

    assert "같은 batch" in executor
    assert "invalidated requirement" in executor
    assert "모든 plan 명령을 일괄 재실행하는 것은 금지" in reviewer
    assert "reuse: forbid" in reviewer
    assert "## 실행 Batch" in plan
    assert "## Verification Requirements" in plan


def test_local_documentation_impact_does_not_bootstrap_document_system() -> None:
    declarations = _read(".codex/workflow/declaration-contracts.md")
    wiki = _read(".codex/skills/harness-project-wiki/SKILL.md")

    assert "`none | local | broad | bootstrap`" in declarations
    assert "`local`" in wiki
    assert "문서 체계 생성" in wiki
    assert "수행하지 않는다" in wiki


def test_concrete_legacy_inference_is_outside_runtime_core() -> None:
    assert (ROOT / "harness_codex/compat/workflow_preflight.py").is_file()
    assert (ROOT / "harness_codex/compat/gate_policy.py").is_file()
    assert (ROOT / "harness_codex/compat/verify_work_item.py").is_file()

    core = "\n".join(
        _read(path)
        for path in (
            "harness_codex/runtime/models.py",
            "harness_codex/runtime/contract_evidence.py",
        )
    ).casefold()
    for forbidden in (
        "harness_full_workflow",
        "harvest-requirements",
        "./gradlew",
        "docker compose",
        "docs/plans/active",
        "harness-review",
    ):
        assert forbidden not in core


def test_runtime_architecture_keeps_decisions_in_orchestration() -> None:
    architecture = _read("docs/architecture/runtime-refactor.md")

    assert "다음 step, retry, remediation, scope 확장" in architecture
    assert "반환하지 않는다" in architecture
    assert "두 릴리스" in architecture
