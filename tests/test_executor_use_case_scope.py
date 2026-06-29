from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


def read_executor() -> str:
    path = REPO_ROOT / ".codex/agents/implementation_executor.toml"
    return path.read_text(encoding="utf-8") + "\n" + (
        path.parent / "references/implementation_executor.md"
    ).read_text(encoding="utf-8")


def test_executor_runs_only_targeted_work_item_plan() -> None:
    executor = read_executor()
    assert 'sandbox_mode = "danger-full-access"' in executor
    assert "docs/plans/active/<WORK-ITEM-ID>/plan.md" in executor
    assert "execution-scope.json" in executor
    assert "docs/plans/active/plan.md" not in executor
    assert "Do not edit other work-item plans or upstream design documents" in executor


def test_executor_uses_plan_and_runtime_scope_boundaries() -> None:
    executor = read_executor()
    assert "sole product and implementation instruction" in executor
    assert "runtime-owned execution-scope artifact" in executor
    assert "completed resume state" in executor
    assert "first remaining `- [ ]` checkbox" in executor


def test_executor_excludes_upstream_design_reinterpretation() -> None:
    executor = read_executor()
    assert "Do not read use-case, event-storming, E2E-goal" in executor
    assert "or other upstream design artifacts" in executor


def test_executor_records_environment_blocker_for_focused_verification_limits() -> None:
    executor = read_executor()
    assert "focused commands named in the active plan" in executor
    assert "browser installation, network, credentials, permissions" in executor
    assert "environment blocker" in executor
    assert "HTTP/API probes alone do not satisfy a browser E2E task" in executor


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
