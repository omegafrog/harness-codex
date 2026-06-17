from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_executor() -> str:
    path = REPO_ROOT / ".codex/agents/implementation_executor.toml"
    return path.read_text(encoding="utf-8") + "\n" + (
        path.parent / "references/implementation_executor.md"
    ).read_text(encoding="utf-8")


def test_executor_runs_only_targeted_use_case_plan() -> None:
    executor = read_executor()

    assert 'sandbox_mode = "danger-full-access"' in executor
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
    assert "docs/plans/active/<UC-ID>/verification.md" in executor
    assert "implementation-specific test suite details" in executor
    assert "./gradlew test" in executor
    assert "./gradlew e2eTest" in executor
    assert "Playwright browser install" in executor
    assert "includes a UI and that UI is served in a web environment accessible to Playwright" in executor
    assert "HTTP/API probes alone do not satisfy use-case E2E verification" in executor
    assert "no browser-accessible web UI can be started" in executor
    assert "continue using the existing API/runtime verification path" in executor
    assert "same-origin proxy or CORS behavior" in executor
    assert "A CORS-blocked request is an implementation failure" in executor
    assert "environment blocker" in executor


def test_executor_uses_lombok_and_constructor_injection_for_java_spring() -> None:
    executor = read_executor()

    assert "`@Getter` and `@RequiredArgsConstructor`" in executor
    assert "Use constructor injection for dependencies" in executor
    assert "`private final` dependency fields" in executor
    assert "do not use field injection or setter injection" in executor


def test_executor_maintains_versioned_app_launcher_contract() -> None:
    executor = read_executor()

    assert "scripts/run-app-infra.sh" in executor
    assert "scripts/run-app-server.sh" in executor
    assert "scripts/check-app-infra.sh" in executor
    assert "compose.yaml" in executor
    assert "harness run app" in executor
