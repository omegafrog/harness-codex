from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).parents[1]


def _read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def test_verification_level_is_inferred_and_propagated() -> None:
    declarations = _read(".codex/workflow/declaration-contracts.md")
    requirements = _read(".codex/agents/references/requirements_interviewer.md")
    planner = _read(".codex/agents/references/implementation_planner.md")
    reviewer = _read(".codex/agents/references/reviewer.md")

    for level in ("unit_ready", "component_ready", "live_e2e_ready"):
        assert f"`{level}`" in declarations
        assert level in planner
        assert level in reviewer
    assert "profile을 먼저 추론" in declarations
    assert "모호하거나 비용·환경 차이가 크면 사용자에게 질문" in declarations
    assert "Verification Profile" in requirements


def test_smoke_component_and_live_e2e_evidence_are_distinct() -> None:
    declarations = _read(".codex/workflow/declaration-contracts.md")
    verification = _read(".harness/docs/templates/plans/verification.md")

    assert "health·Swagger·UI root는 `smoke`" in declarations
    assert "fake provider 기반 검증은\n`component`" in declarations
    assert "live_e2e_ready` 증거로 승격하지 않는다" in declarations
    for layer in ("Smoke", "Component", "Live E2E"):
        assert layer in verification


def test_deferred_findings_block_completion_until_disposition() -> None:
    declarations = _read(".codex/workflow/declaration-contracts.md")
    main_steps = _read(".codex/workflow/main-steps.md")
    review = _read(".codex/agents/references/reviewer.md")

    for disposition in ("accepted_scope", "follow_up_changeset", "github_issue"):
        assert f"`{disposition}`" in declarations
        assert disposition in main_steps
    assert "W7은 `needs_input`" in declarations
    assert "C1/C2로 진행하지 않는다" in declarations
    assert "unresolved finding 0건" in main_steps
    assert "GitHub Issue는 자동 생성하지 않는다" in declarations
    assert "needs_input" in review


def test_profile_is_present_in_workflow_templates() -> None:
    paths = (
        ".codex/workflow/changeset-template.md",
        ".harness/docs/templates/changes/change-set.md",
        ".codex/skills/harness-plan-document/references/template.md",
        ".harness/docs/templates/plans/verification.md",
        ".codex/skills/harness-review-document/references/template.md",
    )

    for path in paths:
        text = _read(path)
        assert "Verification Profile" in text, path


def test_findings_are_present_in_changeset_verification_and_review_templates() -> None:
    paths = (
        ".codex/workflow/changeset-template.md",
        ".harness/docs/templates/changes/change-set.md",
        ".harness/docs/templates/plans/verification.md",
        ".codex/skills/harness-review-document/references/template.md",
    )

    for path in paths:
        text = _read(path)
        assert "Deferred Finding" in text or "Deferred Findings" in text, path
