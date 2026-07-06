from harness_codex.runtime.runner import (
    _plan_declares_ci_runtime_coverage,
    _plan_requires_ci_runtime_coverage,
)


def test_runtime_server_plan_requires_ci_coverage() -> None:
    plan = """
## 작업 체크리스트
- [ ] TASK-001 `scripts/app/dev/start.sh`: 새 서버를 Docker Compose로 실행한다.

## 집중 검증
- [ ] VERIFY-001 Runtime server verification: `harness run app` 후 `/actuator/health` 확인.
"""

    assert _plan_requires_ci_runtime_coverage(plan)
    assert not _plan_declares_ci_runtime_coverage(plan)


def test_runtime_server_plan_accepts_github_actions_coverage() -> None:
    plan = """
## 작업 체크리스트
- [ ] TASK-001 `scripts/app/dev/start.sh`: 새 서버를 Docker Compose로 실행한다.
- [ ] TASK-002 `.github/workflows/app-runtime.yml`: CI에서 bounded build/test와 smoke 검증을 실행한다.

## 집중 검증
- [ ] VERIFY-001 Runtime server verification: `harness run app` 후 `/actuator/health` 확인.
- [ ] VERIFY-002 CI: `.github/workflows/app-runtime.yml`이 build, test, smoke 단계를 포함한다.
"""

    assert _plan_requires_ci_runtime_coverage(plan)
    assert _plan_declares_ci_runtime_coverage(plan)


def test_runtime_server_plan_accepts_ci_not_applicable_reason() -> None:
    plan = """
## 작업 체크리스트
- [ ] TASK-001 `Dockerfile.runtime`: 새 실행 artifact 이미지를 정의한다.

## 집중 검증
- [ ] VERIFY-001 Runtime server verification: `harness run app` 후 `/actuator/health` 확인.
- [ ] VERIFY-002 CI: N/A - repository has no GitHub Actions setup; local build/test/smoke commands provide replacement evidence.
"""

    assert _plan_requires_ci_runtime_coverage(plan)
    assert _plan_declares_ci_runtime_coverage(plan)
