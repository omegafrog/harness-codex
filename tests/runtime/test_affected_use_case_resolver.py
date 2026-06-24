import json
from hashlib import sha256
from pathlib import Path

import pytest

from harness_codex.runtime.changes import (
    ChangeSetResolver,
    NoActiveChangeSetsError,
    PlanningBlocked,
)
from harness_codex.runtime.changes.models import ChangeSet, WorkItemType


def write_changeset(tmp_path: Path, body: str) -> Path:
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    path = active_dir / "CHG-001.md"
    path.write_text(body, encoding="utf-8")
    return path


def write_verified_design_visualization(tmp_path: Path, slice_dir: Path, uc_id: str) -> None:
    context_path = tmp_path / "context.md"
    architecture_path = tmp_path / "ARCHITECTURE.md"
    context_path.write_text("# context\n", encoding="utf-8")
    architecture_path.write_text("# architecture\n", encoding="utf-8")
    (slice_dir / "class-diagram.md").write_text(
        "# Class Diagram\n\n```mermaid\nclassDiagram\n    class Payment\n```\n",
        encoding="utf-8",
    )
    (slice_dir / "flow-diagram.md").write_text(
        "# Flow Diagram\n\n```mermaid\nflowchart TD\n    A[Request] --> B[Payment]\n```\n",
        encoding="utf-8",
    )
    source_paths = (
        slice_dir / "use-case.md",
        slice_dir / "e2e-goal.md",
        slice_dir / "event-storming.md",
        slice_dir / "ddd-design.md",
        slice_dir / "technical-decisions.md",
        context_path,
        architecture_path,
    )
    source_documents = {
        str(path.relative_to(tmp_path)): f"sha256:{sha256(path.read_bytes()).hexdigest()}"
        for path in source_paths
    }
    (slice_dir / "diagram-metadata.json").write_text(
        json.dumps(
            {
                "change_set_id": "CHG-001",
                "uc_id": uc_id,
                "status": "verified",
                "source_documents": source_documents,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def write_use_case_slice(
    tmp_path: Path,
    uc_id: str = "UC-001",
    *,
    approval_status: str | None = None,
    technical_approval_status: str | None = "approved",
    pending_decisions: str = "- None",
    include_technical_decisions: bool = True,
) -> None:
    slice_dir = tmp_path / "docs/use-cases" / uc_id
    slice_dir.mkdir(parents=True)
    (slice_dir / "use-case.md").write_text("# use case\n", encoding="utf-8")
    (slice_dir / "event-storming.md").write_text("# event storming\n", encoding="utf-8")
    (slice_dir / "ddd-design.md").write_text("# ddd design\n", encoding="utf-8")
    if approval_status is not None:
        e2e_goal = f"""# e2e goal

## 1. Metadata

|Item|Value|
|---|---|
|Approval Status|{approval_status}|
"""
    else:
        e2e_goal = "# e2e goal\n"
    (slice_dir / "e2e-goal.md").write_text(e2e_goal, encoding="utf-8")
    if include_technical_decisions:
        if technical_approval_status is None:
            metadata = "|ChangeSet|CHG-001|\n"
        else:
            metadata = (
                "|ChangeSet|CHG-001|\n"
                f"|Approval Status|{technical_approval_status}|\n"
            )
        (slice_dir / "technical-decisions.md").write_text(
            "# UC-001. Technical Decisions\n\n"
            "## 1. Metadata\n"
            "|Item|Value|\n"
            "|---|---|\n"
            f"{metadata}"
            "\n"
            "## 7. Pending Decisions\n"
            f"{pending_decisions}\n",
            encoding="utf-8",
        )
        write_verified_design_visualization(tmp_path, slice_dir, uc_id)


CHANGESET = """# ChangeSet CHG-001

## 1. 메타데이터
|항목|값|
|---|---|
|ChangeSet ID|`CHG-001`|
|상태|active|

## 5. 영향 유스케이스
|UC ID|유스케이스 이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`UC-001`|결제 승인|update|`docs/use-cases/UC-001/`|planned|

## 7. Planner 입력 범위
- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`
- `.codex/repository-settings.md`
"""


CHANGESET_WITH_PENDING_APPROVAL = """# ChangeSet CHG-001

## 1. 메타데이터
|항목|값|
|---|---|
|ChangeSet ID|`CHG-001`|
|상태|active|

## 5. 영향 유스케이스
|UC ID|유스케이스 이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`UC-001`|결제 승인|update|`docs/use-cases/UC-001/`|planned|

## 7. Verification Goal Changes
|Work Item ID|Verification Goal Path|Change Status|Approval Status|Notes|
|---|---|---|---|---|
|`UC-001`|`docs/use-cases/UC-001/e2e-goal.md`|new|pending|Generated from design intake|

## 8. Planner Input Scope
- `docs/changes/active/<CHG-ID>.md`
- `docs/use-cases/<UC-ID>/use-case.md`
- `docs/use-cases/<UC-ID>/event-storming.md`
- `docs/use-cases/<UC-ID>/e2e-goal.md`
- `.codex/repository-settings.md`
"""


CHANGESET_WITH_APPROVED_APPROVAL = CHANGESET_WITH_PENDING_APPROVAL.replace(
    "|`UC-001`|`docs/use-cases/UC-001/e2e-goal.md`|new|pending|Generated from design intake|",
    "|`UC-001`|`docs/use-cases/UC-001/e2e-goal.md`|new|approved|Generated from design intake|",
)


CHANGESET_WITH_BLANK_APPROVAL = CHANGESET_WITH_PENDING_APPROVAL.replace(
    "|`UC-001`|`docs/use-cases/UC-001/e2e-goal.md`|new|pending|Generated from design intake|",
    "|`UC-001`|`docs/use-cases/UC-001/e2e-goal.md`|new||Generated from design intake|",
)


def test_resolver_lists_active_changesets(tmp_path: Path) -> None:
    write_changeset(tmp_path, CHANGESET)
    resolver = ChangeSetResolver(tmp_path)

    active = resolver.list_active()

    assert len(active) == 1
    assert active[0].change_set_id == "CHG-001"
    assert active[0].path == Path("docs/changes/active/CHG-001.md")


def test_resolver_raises_when_no_active_changeset(tmp_path: Path) -> None:
    (tmp_path / "docs/changes/active").mkdir(parents=True)
    resolver = ChangeSetResolver(tmp_path)

    with pytest.raises(NoActiveChangeSetsError):
        resolver.list_active()


def test_resolver_builds_per_use_case_planning_scope(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    write_use_case_slice(tmp_path)
    resolver = ChangeSetResolver(tmp_path)

    scopes = resolver.resolve_planning_scopes(resolver.load(path))

    assert not isinstance(scopes, PlanningBlocked)
    scope = scopes[0]
    assert scope.change_set_path == Path("docs/changes/active/CHG-001.md")
    assert scope.use_case is not None
    assert scope.use_case.uc_id == "UC-001"
    assert Path("docs/changes/active/CHG-001.md") in scope.planner_inputs
    assert Path("docs/use-cases/UC-001/e2e-goal.md") in scope.planner_inputs
    assert Path("docs/use-cases/UC-001/ddd-design.md") in scope.planner_inputs
    assert Path("docs/use-cases/UC-001/technical-decisions.md") in scope.planner_inputs
    assert Path("docs/use-cases/UC-001/class-diagram.md") in scope.planner_inputs
    assert Path("docs/use-cases/UC-001/flow-diagram.md") in scope.planner_inputs
    assert Path("docs/plans/active/UC-001/plan.md") in scope.executor_inputs
    assert scope.e2e_goal_path == Path("docs/use-cases/UC-001/e2e-goal.md")


def test_resolver_blocks_when_no_affected_work_items(tmp_path: Path) -> None:
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    change_set_path = active_dir / "CHG-EMPTY.md"
    change_set_path.write_text("# ChangeSet CHG-EMPTY\n", encoding="utf-8")
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(
        ChangeSet(
            change_set_id="CHG-EMPTY",
            title="empty",
            path=Path("docs/changes/active/CHG-EMPTY.md"),
        )
    )

    assert isinstance(result, PlanningBlocked)
    assert result.reason == "ChangeSet has no affected work items"


def test_resolver_blocks_missing_use_case_documents(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    (tmp_path / "docs/use-cases/UC-001").mkdir(parents=True)
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "Use case work item UC-001 is missing required documents" in result.reason


def test_resolver_blocks_missing_technical_decisions_before_planning(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    write_use_case_slice(tmp_path, include_technical_decisions=False)
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "Use case work item UC-001 is missing required documents" in result.reason
    assert "docs/use-cases/UC-001/technical-decisions.md" in result.reason


def test_resolver_blocks_pending_technical_decision_approval_before_planning(
    tmp_path: Path,
) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    write_use_case_slice(tmp_path, technical_approval_status="pending")
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "Use case work item UC-001 is waiting for technical-decision approval" in result.reason
    assert "status=pending" in result.reason
    assert "docs/use-cases/UC-001/technical-decisions.md" in result.reason


def test_resolver_blocks_missing_technical_decision_approval_before_planning(
    tmp_path: Path,
) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    write_use_case_slice(tmp_path, technical_approval_status=None)
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "status=<missing>" in result.reason
    assert "docs/use-cases/UC-001/technical-decisions.md" in result.reason


def test_resolver_blocks_pending_technical_decision_items_before_planning(
    tmp_path: Path,
) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    write_use_case_slice(
        tmp_path,
        pending_decisions="- Transaction boundary for payment confirmation is not decided.",
    )
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "Use case work item UC-001 has pending technical decisions" in result.reason
    assert "Transaction boundary for payment confirmation is not decided" in result.reason
    assert "docs/use-cases/UC-001/technical-decisions.md" in result.reason


def test_resolver_blocks_pending_e2e_approval_before_planning(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    write_use_case_slice(tmp_path, approval_status="pending")
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "Use case work item UC-001 is waiting for E2E goal approval" in result.reason
    assert "status=pending" in result.reason
    assert "docs/use-cases/UC-001/e2e-goal.md" in result.reason


def test_resolver_prefers_e2e_front_matter_approval_over_body_table(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    write_use_case_slice(tmp_path, approval_status="approved")
    e2e_goal = tmp_path / "docs/use-cases/UC-001/e2e-goal.md"
    e2e_goal.write_text(
        "---\n"
        "approval_status: pending\n"
        "contract_version: 1\n"
        "doc_type: e2e_goal\n"
        "---\n"
        + e2e_goal.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "status=pending" in result.reason


def test_resolver_blocks_pending_changeset_approval_before_planning(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET_WITH_PENDING_APPROVAL)
    write_use_case_slice(tmp_path, approval_status="approved")
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "Use case work item UC-001 is waiting for E2E goal approval" in result.reason
    assert "status=pending" in result.reason


def test_resolver_blocks_blank_changeset_approval_before_planning(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET_WITH_BLANK_APPROVAL)
    write_use_case_slice(tmp_path, approval_status="approved")
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "status=<blank>" in result.reason


def test_resolver_allows_approved_changeset_approval(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET_WITH_APPROVED_APPROVAL)
    write_use_case_slice(tmp_path, approval_status="pending")
    resolver = ChangeSetResolver(tmp_path)

    scopes = resolver.resolve_planning_scopes(resolver.load(path))

    assert not isinstance(scopes, PlanningBlocked)
    assert scopes[0].display_id == "UC-001"


def test_resolver_allows_approved_e2e_goal(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    write_use_case_slice(tmp_path, approval_status="approved")
    resolver = ChangeSetResolver(tmp_path)

    scopes = resolver.resolve_planning_scopes(resolver.load(path))

    assert not isinstance(scopes, PlanningBlocked)
    assert scopes[0].display_id == "UC-001"


def test_resolver_blocks_stale_design_visualization_before_planning(tmp_path: Path) -> None:
    path = write_changeset(tmp_path, CHANGESET)
    write_use_case_slice(tmp_path, approval_status="approved")
    (tmp_path / "context.md").write_text("# changed context\n", encoding="utf-8")
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_planning_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "invalid or stale design visualization" in result.reason
    assert "stale diagram source hash for context.md" in result.reason


def test_resolver_builds_maintenance_planning_scope(tmp_path: Path) -> None:
    maintenance_dir = tmp_path / "docs/maintenance/MAINT-001"
    maintenance_dir.mkdir(parents=True)
    for name in (
        "scope.md",
        "change-intent.md",
        "affected-files.md",
        "maintenance-spec.md",
        "architecture-impact.md",
        "verification-goal.md",
        "links.md",
    ):
        (maintenance_dir / name).write_text(name, encoding="utf-8")
    body = """# ChangeSet CHG-001

## 1. 메타데이터
|항목|값|
|---|---|
|ChangeSet ID|`CHG-001`|
|상태|active|

## 6. 영향 maintenance
|Maintenance ID|작업 이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`MAINT-001`|테스트 게이트 정리|update|`docs/maintenance/MAINT-001/`|planned|
"""
    path = write_changeset(tmp_path, body)
    resolver = ChangeSetResolver(tmp_path)

    scopes = resolver.resolve_work_item_scopes(resolver.load(path))

    assert not isinstance(scopes, PlanningBlocked)
    scope = scopes[0]
    assert scope.work_item_id == "MAINT-001"
    assert scope.work_item_type == WorkItemType.MAINTENANCE
    assert scope.plan_path == Path("docs/plans/active/MAINT-001/plan.md")
    assert Path("docs/maintenance/MAINT-001/verification-goal.md") in scope.planner_inputs
    assert Path("docs/maintenance/MAINT-001/scope.md") in scope.planner_inputs
    assert Path("docs/maintenance/MAINT-001/architecture-impact.md") in scope.planner_inputs


def test_resolver_blocks_missing_maintenance_documents(tmp_path: Path) -> None:
    (tmp_path / "docs/maintenance/MAINT-001").mkdir(parents=True)
    body = """# ChangeSet CHG-001

## 1. 메타데이터
|항목|값|
|---|---|
|ChangeSet ID|`CHG-001`|
|상태|active|

## 6. 영향 maintenance
|Maintenance ID|작업 이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`MAINT-001`|테스트 게이트 정리|update|`docs/maintenance/MAINT-001/`|planned|
"""
    path = write_changeset(tmp_path, body)
    resolver = ChangeSetResolver(tmp_path)

    result = resolver.resolve_work_item_scopes(resolver.load(path))

    assert isinstance(result, PlanningBlocked)
    assert "missing required documents" in result.reason
