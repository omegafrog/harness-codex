from __future__ import annotations

import json
import subprocess
from pathlib import Path

from harness_codex.runtime.reconcile_affected_files import reconcile_affected_files


def test_reconcile_affected_files_updates_manifest_before_review(
    tmp_path: Path,
) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
    _write_changeset(tmp_path)
    _write_file(tmp_path / "notification/src/main/java/org/example/notification/ui/NotificationQueryController.java")
    _write_file(tmp_path / "notification/src/main/java/org/example/notification/application/NotificationQueryService.java")
    _write_file(tmp_path / "notification/src/main/java/org/example/notification/infra/NotificationInboxViewReaderAdapter.java")
    _write_file(tmp_path / "notification/src/test/java/org/example/notification/ui/NotificationQueryControllerTest.java")
    subprocess.run(["git", "add", "notification"], cwd=tmp_path, check=True)
    affected = tmp_path / "docs/use-cases/UC-001/affected-files.md"
    affected.parent.mkdir(parents=True, exist_ok=True)
    affected.write_text(
        """# UC-001 Affected Files

## Expected Files
- `notification/src/main/java/org/example/notification/controller/NotificationQueryController.java`
- `notification/src/main/java/org/example/notification/application/service/NotificationQueryService.java`

## Test Targets
- `notification/src/test/java/org/example/notification/**`
""",
        encoding="utf-8",
    )
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(
        """# 구현 계획

## 실행 경계
- `notification/**`

## 작업 체크리스트
- [ ] `notification/src/main/java/org/example/notification/infra/NotificationInboxViewReaderAdapter.java` 추가.
- [ ] `notification/src/test/java/org/example/notification/ui/NotificationQueryControllerTest.java` 보강.
""",
        encoding="utf-8",
    )

    result = reconcile_affected_files(
        repo_root=tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
        output_path=Path(".harness/runs/run-001/work-items/UC-001/affected-files-repair.json"),
    )

    assert result.changed is True
    repaired = affected.read_text(encoding="utf-8")
    assert "## Modify" in repaired
    assert "`notification/src/main/java/org/example/notification/ui/NotificationQueryController.java`" in repaired
    assert "`notification/src/main/java/org/example/notification/application/NotificationQueryService.java`" in repaired
    assert "`notification/src/main/java/org/example/notification/infra/NotificationInboxViewReaderAdapter.java`" in repaired
    assert "`notification/src/test/java/org/example/notification/ui/NotificationQueryControllerTest.java`" in repaired
    payload = json.loads(
        (tmp_path / ".harness/runs/run-001/work-items/UC-001/affected-files-repair.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["changed"] is True


def test_reconcile_affected_files_excludes_policy_and_verification_paths(
    tmp_path: Path,
) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
    _write_changeset(tmp_path, included=("notification/**", "scripts/**"))
    _write_file(tmp_path / "notification/src/main/java/org/example/notification/ui/NotificationQueryController.java")
    _write_file(tmp_path / "notification/build.gradle")
    _write_file(tmp_path / "notification/AGENTS.md")
    _write_file(tmp_path / ".semgrep/ddd-architecture.yml")
    _write_file(tmp_path / "scripts/run-app-server.sh")
    _write_file(tmp_path / "scripts/run-app-infra.sh")
    (tmp_path / "notification/src/test/java").mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "add", "."], cwd=tmp_path, check=True)
    affected = tmp_path / "docs/use-cases/UC-001/affected-files.md"
    affected.parent.mkdir(parents=True, exist_ok=True)
    affected.write_text(
        """# UC-001 Affected Files

## Modify
- `notification/src/main/java/org/example/notification/ui/NotificationQueryController.java`
- `notification/AGENTS.md`
- `.semgrep/ddd-architecture.yml`
- `scripts/run-app-infra.sh`
""",
        encoding="utf-8",
    )
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text(
        """# 구현 계획

## 실행 경계
- scope repair: `notification/**` 수정, `scripts/run-app-infra.sh` 제외.
- 구현 소스: `notification/src/main/java/org/example/notification/ui/NotificationQueryController.java`
- 빌드 설정: `notification/build.gradle`
- 실행 스크립트: `scripts/run-app-server.sh`
- 검증 디렉터리: `notification/src/test/java`

## 외부 계약 읽기 허용 목록
- `notification/AGENTS.md` 읽기 전용 컨텍스트.

## 작업 체크리스트
- [ ] `notification/src/main/java/org/example/notification/ui/NotificationQueryController.java` 수정.
- [ ] `notification/build.gradle` 테스트 의존성 확인.
- [ ] `scripts/run-app-server.sh` 런처 확인.
- [ ] `scripts/run-app-infra.sh` 런타임 smoke 제외.

## 집중 검증
- [ ] VERIFY-001 `semgrep --config .semgrep/ddd-architecture.yml notification/src/main/java notification/src/test/java`
""",
        encoding="utf-8",
    )

    result = reconcile_affected_files(
        repo_root=tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        plan_path=Path("docs/plans/active/UC-001/plan.md"),
    )

    assert result.changed is True
    repaired = affected.read_text(encoding="utf-8")
    assert "`notification/src/main/java/org/example/notification/ui/NotificationQueryController.java`" in repaired
    assert "`notification/build.gradle`" in repaired
    assert "`scripts/run-app-server.sh`" in repaired
    assert "scripts/run-app-infra.sh" not in repaired
    assert "notification/src/test/java" not in repaired
    assert "AGENTS.md" not in repaired
    assert ".semgrep/ddd-architecture.yml" not in repaired
    assert "notification/src/test/java" not in repaired


def _write_changeset(root: Path, *, included: tuple[str, ...] = ("notification/**",)) -> None:
    path = root / "docs/changes/active/CHG-001.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(
            [
                "# ChangeSet CHG-001",
                "",
                "## 1. Metadata",
                "|Item|Value|",
                "|---|---|",
                "|ChangeSet ID|`CHG-001`|",
                "|Status|active|",
                "",
                "## 8. Scope Boundary",
                "### Included",
                *(f"- `{pattern}`" for pattern in included),
                "",
                "### Excluded",
                "- `app/**`",
                "",
            ]
        ),
        encoding="utf-8",
    )


def _write_file(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("content\n", encoding="utf-8")
