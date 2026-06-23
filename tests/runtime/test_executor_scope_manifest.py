import json
from pathlib import Path

from harness_codex.runtime.validate_scope_diff import ScopePattern, validate_scope_diff


CHANGE_SET_PATH = "docs/changes/active/CHG-001.md"
WORK_ITEM_ID = "UC-001"
PLAN_PATH = "docs/plans/active/UC-001/plan.md"
MANIFEST_PATH = "docs/use-cases/UC-001/affected-files.md"


def _snapshot(path: str, *, state: str = "file", digest: str = "sha") -> dict[str, dict[str, str]]:
    return {path: {"path": path, "state": state, "sha256": digest}}


def _write_changeset(repo_root: Path, *, included: tuple[str, ...] = ("src/auth/**",)) -> None:
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
        "- `src/payment/**`",
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


def test_implementation_change_requires_changeset_and_manifest_intersection(
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

    assert result.status == "blocked"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    row = report["blocked"][0]
    assert row["change_set_sources"] == ["ChangeSet included scope"]
    assert row["manifest_sources"] == []


def test_manifest_create_glob_allows_new_helper_and_test_files(tmp_path: Path) -> None:
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
    assert any("affected-files create" in source for source in report["allowed"][0]["allowed_sources"])


def test_create_permission_does_not_authorize_modifying_existing_file(tmp_path: Path) -> None:
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

    assert result.status == "blocked"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["blocked"][0]["operation"] == "modify"
    assert report["blocked"][0]["manifest_sources"] == []


def test_manifest_forbidden_pattern_overrides_changeset_and_manifest_allow(tmp_path: Path) -> None:
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

    assert result.status == "blocked"
    report = json.loads(result.report_path.read_text(encoding="utf-8"))
    assert report["blocked"][0]["blocked_sources"] == [
        f"affected-files forbidden {MANIFEST_PATH}"
    ]


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
    assert sources[".harness/runs/run-001/steps/execute-work-item/evidence/build.txt"] == [
        "runtime evidence"
    ]
