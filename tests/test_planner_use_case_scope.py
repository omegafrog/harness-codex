from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_planner() -> str:
    skill = REPO_ROOT / ".codex/skills/harness-code-planner/SKILL.md"
    return skill.read_text(encoding="utf-8") + "\n" + (
        skill.parent / "references/detailed-instructions.md"
    ).read_text(encoding="utf-8")


def test_planner_writes_work_item_scoped_active_plan() -> None:
    planner = read_planner()

    assert "docs/plans/active/<WORK-ITEM-ID>/plan.md" in planner
    assert "docs/plans/completed/<WORK-ITEM-ID>/plan.md" in planner
    assert "docs/plans/active/<UC-ID>/plan.md" not in planner
    assert "docs/plans/completed/<UC-ID>/plan.md" not in planner
    assert "docs/plans/active/plan.md" not in planner
    assert "docs/plans/complete/plan.md" not in planner


def test_planner_uses_changeset_and_work_item_slice_as_inputs() -> None:
    planner = read_planner()

    required_inputs = [
        "docs/changes/active/<CHG-ID>.md",
        "docs/use-cases/<UC-ID>/use-case.md",
        "docs/use-cases/<UC-ID>/event-storming.md",
        "docs/use-cases/<UC-ID>/ddd-design.md",
        "docs/use-cases/<UC-ID>/e2e-goal.md",
        "docs/maintenance/<MAINT-ID>/change-intent.md",
        "docs/maintenance/<MAINT-ID>/affected-files.md",
        "docs/maintenance/<MAINT-ID>/verification-goal.md",
        ".codex/repository-settings.md",
        "ARCHITECTURE.md",
    ]

    for input_path in required_inputs:
        assert input_path in planner

    assert "ChangeSet Before/After delta" in planner
    assert "work-item slice" in planner


def test_planner_requires_e2e_or_maintenance_and_repository_gate_verification() -> None:
    planner = read_planner()

    assert "./gradlew build" in planner
    assert "./gradlew test" in planner
    assert ".codex/test-gate.yaml" in planner
    assert "E2E or maintenance verification" in planner
    assert "E2E/verification goal" in planner
    assert "technical-decisions.md` is not explicitly approved" in planner


def test_planner_tracks_domain_impact_and_compatibility() -> None:
    planner = read_planner()

    assert "domain-impact.md" in planner
    assert "aggregate-delta.md" in planner
    assert "docs/domain/<BC-ID>/aggregates/<AGG-ID>.md" in planner
    assert "Compatibility tests" in planner
    assert "another active ChangeSet modifies the same canonical domain element" in planner


def test_planner_requires_versioned_app_launcher_contract() -> None:
    planner = read_planner()

    assert "scripts/run-app.sh" in planner
    assert "compose.yaml" in planner
    assert "harness run app" in planner
