from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_executor() -> str:
    return (REPO_ROOT / ".codex/agents/implementation_executor.toml").read_text(
        encoding="utf-8"
    )


def test_executor_runs_only_targeted_use_case_plan() -> None:
    executor = read_executor()

    assert "docs/plans/active/<UC-ID>/plan.md" in executor
    assert "docs/plans/active/plan.md" not in executor
    assert "Do not edit other UC plans or other UC documents" in executor


def test_executor_uses_changeset_and_uc_slice_boundaries() -> None:
    executor = read_executor()

    required_inputs = [
        "docs/use-cases/<UC-ID>/use-case.md",
        "docs/use-cases/<UC-ID>/event-storming.md",
        "docs/use-cases/<UC-ID>/e2e-goal.md",
        "docs/changes/active/<CHG-ID>.md",
        ".codex/repository-settings.md",
    ]

    for input_path in required_inputs:
        assert input_path in executor

    assert "Keep all edits inside the active ChangeSet scope" in executor


def test_executor_records_environment_blocker_for_e2e_limits() -> None:
    executor = read_executor()

    assert "Do not edit docs/use-cases/<UC-ID>/e2e-goal.md" in executor
    assert "./gradlew test" in executor
    assert "./gradlew e2eTest" in executor
    assert "Playwright browser install" in executor
    assert "use Playwright MCP to verify the flow as an end user through the rendered UI" in executor
    assert "HTTP/API probes alone do not satisfy use-case E2E verification" in executor
    assert "environment blocker" in executor
