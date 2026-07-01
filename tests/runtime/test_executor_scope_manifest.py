import json
import subprocess
from pathlib import Path

from harness_codex.runtime.validate_scope_diff import ScopePattern, validate_scope_diff


CHANGE_SET_PATH = "docs/changes/active/CHG-001.md"
WORK_ITEM_ID = "UC-001"
PLAN_PATH = "docs/plans/active/UC-001/plan.md"
MANIFEST_PATH = "docs/use-cases/UC-001/affected-files.md"


def _snapshot(path: str, *, state: str = "file", digest: str = "sha") -> dict[str, dict[str, str]]:
    return {path: {"path": path, "state": state, "sha256": digest}}


def _write_changeset(
    repo_root: Path,
    *,
    included: tuple[str, ...] = ("src/auth/**",),
    excluded: tuple[str, ...] = ("src/payment/**",),
) -> None:
    target = repo_root / CHANGE_SET_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    lines = [
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
        *(f"- `{pattern}`" for pattern in excluded),
    ]
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_manifest(repo_root: Path, text: str) -> None:
    target = repo_root / MANIFEST_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def _write_plan_with_injected_paths(repo_root: Path) -> None:
    target = repo_root / PLAN_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        """# Implementation Plan

- Backtick path: `src/payment/PaymentService.py`
- General path: src/payment/GeneralText.py

```text
src/payment/CodeBlock.py
```
""",
        encoding="utf-8",
    )


def _write_plan_with_tasks(repo_root: Path) -> None:
    target = repo_root / PLAN_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        """# Implementation Plan

- [x] Update `src/auth/AllowedService.py` persistence behavior.
- [ ] Add PaymentGateway guard.
""",
        encoding="utf-8",
    )


def _metadata() -> dict[str, object]:
    return {
        "change_set_path": CHANGE_SET_PATH,
        "active_plan_path": PLAN_PATH,
        "active_work_item_id": WORK_ITEM_ID,
        "affected_work_items": [
            {
                "id": WORK_ITEM_ID,
                "executor_inputs": [PLAN_PATH, MANIFEST_PATH],
            }
        ],
    }


def _validate(
    repo_root: Path,
    *,
    before: dict[str, dict[str, str]],
    after: dict[str, dict[str, str]],
    runtime_allow_patterns: tuple[ScopePattern, ...] = (),
):
    return validate_scope_diff(
        repo_root=repo_root,
        run_id="run-001",
        change_set_id="CHG-001",
        work_item_id=WORK_ITEM_ID,
        before=before,
        after=after,
        report_path=repo_root / ".harness/runs/run-001/scope-diff-report.json",
        context_metadata=_metadata(),
        runtime_allow_patterns=runtime_allow_patterns,
    )


def test_plan_path_injection_never_grants_executor_write_authority(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Create
- `src/auth/**`

## Modify
- `src/auth/**`
""",
    )
    _write_plan_with_injected_paths(tmp_path)

    result = _validate(
        tmp_path,
        before={},
        after=_snapshot("src/payment/PaymentService.py", digest="created"),
    )

    assert result.status == "blocked"
    assert result.blocked_files == ("src/payment/PaymentService.py",)
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    row = report["blocked"][0]
    assert row["change_set_sources"] == []
    assert row["manifest_sources"] == []
    assert row["runtime_sources"] == []
    assert report["authority_model"]["plan_paths_grant_implementation_authority"] is False


def test_implementation_change_requires_changeset_scope(
    tmp_path: Path,
) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Modify
- `src/auth/allowed.py`
""",
    )

    result = _validate(
        tmp_path,
        before=_snapshot("src/auth/not-listed.py", digest="before"),
        after=_snapshot("src/auth/not-listed.py", digest="after"),
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    row = report["allowed"][0]
    assert row["change_set_sources"] == ["ChangeSet included scope"]
    assert row["manifest_sources"] == []


def test_scope_diff_report_maps_changed_files_to_plan_tasks(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Modify
- `src/auth/**`
""",
    )
    _write_plan_with_tasks(tmp_path)

    result = _validate(
        tmp_path,
        before=_snapshot("src/auth/AllowedService.py", digest="before"),
        after=_snapshot("src/auth/AllowedService.py", digest="after"),
    )

    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["plan_task_file_map"] == [
        {
            "work_item_id": "UC-001",
            "line": 3,
            "checked": True,
            "text": "Update `src/auth/AllowedService.py` persistence behavior.",
            "files": [
                {
                    "path": "src/auth/AllowedService.py",
                    "status": "M",
                    "operation": "modify",
                }
            ],
            "match": "plan-task-token",
        },
        {
            "work_item_id": "UC-001",
            "line": 4,
            "checked": False,
            "text": "Add PaymentGateway guard.",
            "files": [],
            "match": "plan-task-token",
        },
    ]


def test_runtime_run_artifacts_do_not_block_scope_diff(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Modify
- `src/auth/**`
""",
    )

    result = _validate(
        tmp_path,
        before={},
        after={
            ".harness/runs/run-old/events.ndjson": {
                "path": ".harness/runs/run-old/events.ndjson",
                "state": "file",
                "sha256": "created",
            },
            ".harness/cache/prompt-context/context.md": {
                "path": ".harness/cache/prompt-context/context.md",
                "state": "file",
                "sha256": "created",
            },
        },
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert [row["path"] for row in report["allowed"]] == [
        ".harness/cache/prompt-context/context.md",
        ".harness/runs/run-old/events.ndjson",
    ]
    assert report["blocked"] == []


def test_changeset_scope_allows_new_helper_and_test_files(tmp_path: Path) -> None:
    _write_changeset(tmp_path, included=("src/auth/**", "tests/auth/**"))
    _write_manifest(
        tmp_path,
        """# Affected Files

## Create
- `src/auth/**`
- `tests/auth/**`

## Modify
- `src/auth/**`
""",
    )

    result = _validate(
        tmp_path,
        before={},
        after=_snapshot("tests/auth/test_token_helper.py", digest="created"),
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["allowed"][0]["operation"] == "create"
    assert report["allowed"][0]["allowed_sources"] == ["ChangeSet included scope"]


def test_changeset_scope_authorizes_modifying_existing_file(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Create
- `src/auth/**`
""",
    )

    result = _validate(
        tmp_path,
        before=_snapshot("src/auth/existing.py", digest="before"),
        after=_snapshot("src/auth/existing.py", digest="after"),
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["allowed"][0]["operation"] == "modify"
    assert report["allowed"][0]["manifest_sources"] == []


def test_modify_directory_glob_authorizes_creating_file_inside_boundary(
    tmp_path: Path,
) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Modify
- `src/auth/**`
""",
    )

    result = _validate(
        tmp_path,
        before={},
        after=_snapshot("src/auth/NewPolicy.py", digest="created"),
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["allowed"][0]["operation"] == "create"
    assert report["allowed"][0]["manifest_sources"] == []


def test_changeset_scope_authorizes_creating_included_exact_file(
    tmp_path: Path,
) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Modify
- `src/auth/NewPolicy.py`
""",
    )

    result = _validate(
        tmp_path,
        before={},
        after=_snapshot("src/auth/NewPolicy.py", digest="created"),
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["allowed"][0]["operation"] == "create"
    assert report["allowed"][0]["manifest_sources"] == []


def test_tracked_file_missing_from_before_snapshot_is_still_modify(
    tmp_path: Path,
) -> None:
    subprocess.run(["git", "init"], cwd=tmp_path, check=True, capture_output=True, text=True)
    target = tmp_path / "src/auth/AllowedService.py"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("before\n", encoding="utf-8")
    subprocess.run(["git", "add", str(target.relative_to(tmp_path))], cwd=tmp_path, check=True)
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Expected Files
- `src/auth/AllowedService.py`
""",
    )

    result = _validate(
        tmp_path,
        before={},
        after=_snapshot("src/auth/AllowedService.py", digest="after"),
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["allowed"][0]["operation"] == "modify"
    assert report["allowed"][0]["manifest_sources"] == []


def test_legacy_expected_files_authorize_creating_missing_expected_file(
    tmp_path: Path,
) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Expected Files
- `src/auth/NewExpectedHandler.py`
""",
    )

    result = _validate(
        tmp_path,
        before={},
        after=_snapshot("src/auth/NewExpectedHandler.py", digest="created"),
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["allowed"][0]["operation"] == "create"
    assert report["allowed"][0]["manifest_sources"] == []


def test_legacy_manifest_forbidden_pattern_does_not_override_changeset_scope(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Modify
- `src/auth/**`

## Forbidden
- `src/auth/internal/**`
""",
    )

    result = _validate(
        tmp_path,
        before=_snapshot("src/auth/internal/secret.py", digest="before"),
        after=_snapshot("src/auth/internal/secret.py", digest="after"),
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["allowed"][0]["blocked_sources"] == []


def test_changeset_scope_authorizes_repo_taxonomy_without_manifest_aliases(tmp_path: Path) -> None:
    _write_changeset(tmp_path, included=("notification/src/main/java/org/codenbug/notification/**",))
    _write_manifest(
        tmp_path,
        """# Affected Files

## Expected Files
- `notification/src/main/java/org/codenbug/notification/controller/NotificationCommandController.java`
- `notification/src/main/java/org/codenbug/notification/controller/NotificationCreateRequestDto.java`
- `notification/src/main/java/org/codenbug/notification/application/service/NotificationCommandService.java`
- `notification/src/main/java/org/codenbug/notification/domain/service/NotificationDomainService.java`
- `notification/src/main/java/org/codenbug/notification/infrastructure/NotificationRepository.java`
""",
    )

    after = {
        **_snapshot(
            "notification/src/main/java/org/codenbug/notification/ui/NotificationCommandController.java",
            digest="after-controller",
        ),
        **_snapshot(
            "notification/src/main/java/org/codenbug/notification/ui/dto/NotificationCreateRequestDto.java",
            digest="after-dto",
        ),
        **_snapshot(
            "notification/src/main/java/org/codenbug/notification/application/NotificationCommandService.java",
            digest="after-application",
        ),
        **_snapshot(
            "notification/src/main/java/org/codenbug/notification/domain/NotificationDomainService.java",
            digest="after-domain",
        ),
        **_snapshot(
            "notification/src/main/java/org/codenbug/notification/infra/NotificationRepository.java",
            digest="after-infra",
        ),
    }

    before = {
        path: {**snapshot, "sha256": "before"}
        for path, snapshot in after.items()
    }

    result = _validate(tmp_path, before=before, after=after)

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["blocked"] == []
    assert all(
        row["manifest_sources"] == []
        for row in report["allowed"]
    )


def test_executor_plan_state_and_runtime_evidence_are_separately_allowed(tmp_path: Path) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Modify
- `src/auth/**`
""",
    )

    before = {
        **_snapshot(PLAN_PATH, digest="plan-before"),
        **_snapshot(".harness/runs/run-001/steps/execute-work-item/evidence/build.txt", digest="before"),
    }
    after = {
        **_snapshot(PLAN_PATH, digest="plan-after"),
        **_snapshot(".harness/runs/run-001/steps/execute-work-item/evidence/build.txt", digest="after"),
    }
    result = _validate(
        tmp_path,
        before=before,
        after=after,
        runtime_allow_patterns=(
            ScopePattern(".harness/runs/run-001/", "runtime evidence"),
        ),
    )

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    sources = {row["path"]: row["allowed_sources"] for row in report["allowed"]}
    assert sources[PLAN_PATH] == ["executor-owned active plan state"]
    assert "runtime evidence" in sources[
        ".harness/runs/run-001/steps/execute-work-item/evidence/build.txt"
    ]


def test_generated_verification_outputs_do_not_block_scope_diff(tmp_path: Path) -> None:
    _write_changeset(
        tmp_path,
        included=("src/auth/**",),
        excluded=("src/payment/**", "app/**", "event/**"),
    )
    _write_manifest(
        tmp_path,
        """# Affected Files

## Modify
- `src/auth/**`
""",
    )

    after = {
        **_snapshot(".gradle/8.14.2/checksums/checksums.lock", digest="created"),
        **_snapshot("app/build/reports/tests/architectureRules/index.html", digest="created"),
        **_snapshot("event/build/tmp/compileJava/previous-compilation-data.bin", digest="created"),
        **_snapshot("build/reports/problems/problems-report.html", digest="created"),
        **_snapshot("notification/build/reports/tests/test/index.html", digest="created"),
        **_snapshot(".harness/logs/app-server.log", digest="created"),
        **_snapshot(".harness/ui-server.log", digest="created"),
    }

    result = _validate(tmp_path, before={}, after=after)

    assert result.status == "passed"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert {row["path"] for row in report["allowed"]} == set(after)
    assert all(row["runtime_sources"] for row in report["allowed"])


def test_runtime_outputs_pass_while_control_plane_edits_block_scope_diff(
    tmp_path: Path,
) -> None:
    _write_changeset(tmp_path)
    _write_manifest(
        tmp_path,
        """# Affected Files

## Modify
- `src/auth/**`
""",
    )

    after = {
        **_snapshot(".codex/agents/implementation_executor.toml", digest="created"),
        **_snapshot(".codex/skills/caveman/SKILL.md", digest="created"),
        **_snapshot("harness_codex/runtime/materialize_execution_scope.py", digest="created"),
        **_snapshot("harness_codex/runtime/__pycache__/runner.cpython-313.pyc", digest="created"),
        **_snapshot(".pytest_cache/v/cache/nodeids", digest="created"),
        **_snapshot(".harness/contracts/CHG-001/UC-001/plan.contract.json", digest="created"),
        **_snapshot(".harness/ui-server.pid", digest="created"),
    }

    result = _validate(tmp_path, before={}, after=after)

    assert result.status == "blocked"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert {row["path"] for row in report["allowed"]} == {
        "harness_codex/runtime/__pycache__/runner.cpython-313.pyc",
        ".pytest_cache/v/cache/nodeids",
        ".harness/contracts/CHG-001/UC-001/plan.contract.json",
        ".harness/ui-server.pid",
    }
    assert {row["path"] for row in report["blocked"]} == {
        ".codex/agents/implementation_executor.toml",
        ".codex/skills/caveman/SKILL.md",
        "harness_codex/runtime/materialize_execution_scope.py",
    }
    assert all(row["runtime_sources"] for row in report["allowed"])
