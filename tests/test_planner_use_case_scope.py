from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_planner() -> str:
    return (REPO_ROOT / ".codex/agents/implementation_planner.toml").read_text(
        encoding="utf-8"
    )


def test_planner_writes_use_case_scoped_active_plan() -> None:
    planner = read_planner()

    assert "docs/plans/active/<UC-ID>/plan.md" in planner
    assert "docs/plans/active/plan.md" not in planner
    assert "docs/plans/completed/<UC-ID>/plan.md" in planner


def test_planner_uses_changeset_and_use_case_slice_as_inputs() -> None:
    planner = read_planner()

    required_inputs = [
        "docs/changes/active/<CHG-ID>.md",
        "docs/use-cases/<UC-ID>/use-case.md",
        "docs/use-cases/<UC-ID>/event-storming.md",
        "docs/use-cases/<UC-ID>/e2e-goal.md",
        ".codex/repository-settings.md",
    ]

    for input_path in required_inputs:
        assert input_path in planner

    assert "Before/After delta" in planner


def test_planner_requires_e2e_and_repository_gate_verification() -> None:
    planner = read_planner()

    assert "./gradlew build" in planner
    assert "./gradlew test" in planner
    assert "./gradlew e2eTest" in planner
    assert ".codex/test-gate.yaml" in planner
    assert "E2E 성공 기준" in planner
