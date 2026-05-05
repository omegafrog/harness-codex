from pathlib import Path

import pytest

from harness_codex.runtime.changes import (
    ChangeSetResolver,
    NoActiveChangeSetsError,
    PlanningBlocked,
)
from harness_codex.runtime.changes.models import ChangeSet


def write_changeset(tmp_path: Path, body: str) -> Path:
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    path = active_dir / "CHG-001.md"
    path.write_text(body, encoding="utf-8")
    return path


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
    resolver = ChangeSetResolver(tmp_path)
    change_set = resolver.load(path)

    scopes = resolver.resolve_planning_scopes(change_set)

    assert not isinstance(scopes, PlanningBlocked)
    scope = scopes[0]
    assert scope.change_set_path == Path("docs/changes/active/CHG-001.md")
    assert scope.use_case.uc_id == "UC-001"
    assert Path("docs/changes/active/CHG-001.md") in scope.planner_inputs
    assert Path("docs/use-cases/UC-001/e2e-goal.md") in scope.planner_inputs
    assert Path("docs/plans/active/UC-001/plan.md") in scope.executor_inputs
    assert scope.e2e_goal_path == Path("docs/use-cases/UC-001/e2e-goal.md")


def test_resolver_blocks_when_no_affected_use_cases() -> None:
    resolver = ChangeSetResolver(Path("/repo"))

    result = resolver.resolve_planning_scopes(
        ChangeSet(change_set_id="CHG-EMPTY", title="empty")
    )

    assert isinstance(result, PlanningBlocked)
    assert result.reason == "ChangeSet has no affected use cases"
