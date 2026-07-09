from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.validate_scope_diff import validate_scope_diff


def _snapshot(*paths: str) -> dict[str, dict[str, str | None]]:
    return {path: {"path": path, "state": "file", "sha256": path} for path in paths}


def _write_plan(tmp_path: Path, body: str) -> Path:
    plan = tmp_path / "docs/plans/active/MAINT-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(body, encoding="utf-8")
    return plan


def test_executor_policy_uses_plan_module_boundary_for_source_and_tests(tmp_path: Path) -> None:
    plan = _write_plan(
        tmp_path,
        """
# 구현 계획

```yaml
implementationBoundary:
  source:
    - src/payments/**
  tests:
    - tests/payments/**
  runtimeArtifacts:
    - docs/plans/active/MAINT-001/plan.md
  configExceptions: []
  protected:
    - .harness/system/**
```

## 실행 경계
### 수정 허용 경로
- `src/payments/**`
- `tests/payments/**`

## 작업 체크리스트
- [ ] TASK-001 `src/payments/service.py`: 수정.
""".strip(),
    )
    after = _snapshot(
        "src/payments/service.py",
        "tests/payments/test_service.py",
        "src/users/service.py",
        "tests/users/test_service.py",
    )

    result = validate_scope_diff(
        repo_root=tmp_path,
        run_id="run-1",
        change_set_id="CHG-001",
        work_item_id="MAINT-001",
        before={},
        after=after,
        report_path=tmp_path / "scope-report.json",
        context_metadata={"active_plan_path": str(plan.relative_to(tmp_path))},
    )

    report = json.loads((tmp_path / "scope-report.json").read_text(encoding="utf-8"))
    allowed_paths = {row["path"] for row in report["allowed"]}
    blocked_paths = set(result.blocked_files)

    assert "src/payments/service.py" in allowed_paths
    assert "tests/payments/test_service.py" in allowed_paths
    assert "src/users/service.py" in blocked_paths
    assert "tests/users/test_service.py" in blocked_paths


def test_config_build_script_changes_require_explicit_exception(tmp_path: Path) -> None:
    plan = _write_plan(
        tmp_path,
        """
# 구현 계획

```yaml
implementationBoundary:
  source:
    - src/payments/**
  tests:
    - tests/payments/**
  configExceptions:
    - src/main/resources/ehcache.xml
  runtimeArtifacts:
    - docs/plans/active/MAINT-001/plan.md
  protected:
    - .harness/system/**
```

## 실행 경계
### 수정 허용 경로
- `src/payments/**`
- `tests/payments/**`
- `src/main/resources/ehcache.xml`

## 작업 체크리스트
- [ ] TASK-001 `src/main/resources/ehcache.xml`: 캐시 설정 수정.
""".strip(),
    )
    after = _snapshot(
        "src/main/resources/ehcache.xml",
        "src/main/resources/application.yml",
        "scripts/app/dev/start.sh",
    )

    result = validate_scope_diff(
        repo_root=tmp_path,
        run_id="run-1",
        change_set_id="CHG-001",
        work_item_id="MAINT-001",
        before={},
        after=after,
        report_path=tmp_path / "scope-report.json",
        context_metadata={"active_plan_path": str(plan.relative_to(tmp_path))},
    )

    report = json.loads((tmp_path / "scope-report.json").read_text(encoding="utf-8"))
    allowed_paths = {row["path"] for row in report["allowed"]}
    blocked_paths = set(result.blocked_files)

    assert "src/main/resources/ehcache.xml" in allowed_paths
    assert "src/main/resources/application.yml" in blocked_paths
    assert "scripts/app/dev/start.sh" in blocked_paths


def test_harness_control_plane_is_blocked_but_runtime_outputs_are_allowed(tmp_path: Path) -> None:
    plan = _write_plan(
        tmp_path,
        """
# 구현 계획

```yaml
implementationBoundary:
  source:
    - src/payments/**
  tests:
    - tests/payments/**
  runtimeArtifacts:
    - .harness/runs/**
    - .harness/state/**
    - docs/plans/active/MAINT-001/plan.md
  configExceptions: []
  protected:
    - .harness/system/**
```

## 실행 경계
### 수정 허용 경로
- `src/payments/**`

## 작업 체크리스트
- [ ] TASK-001 `src/payments/service.py`: 수정.
""".strip(),
    )
    after = _snapshot(
        ".harness/runs/run-1/steps/execute/result.json",
        ".harness/state/active-run.json",
        ".harness/system/agents/implementation_executor.toml",
        ".codex/skills/harness-code-planner/SKILL.md",
    )

    result = validate_scope_diff(
        repo_root=tmp_path,
        run_id="run-1",
        change_set_id="CHG-001",
        work_item_id="MAINT-001",
        before={},
        after=after,
        report_path=tmp_path / "scope-report.json",
        context_metadata={"active_plan_path": str(plan.relative_to(tmp_path))},
    )

    report = json.loads((tmp_path / "scope-report.json").read_text(encoding="utf-8"))
    allowed_paths = {row["path"] for row in report["allowed"]}
    blocked_paths = set(result.blocked_files)

    assert ".harness/runs/run-1/steps/execute/result.json" in allowed_paths
    assert ".harness/state/active-run.json" in allowed_paths
    assert ".harness/system/agents/implementation_executor.toml" in blocked_paths
    assert ".codex/skills/harness-code-planner/SKILL.md" in blocked_paths
