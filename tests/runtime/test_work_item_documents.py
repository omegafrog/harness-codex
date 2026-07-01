from pathlib import Path

from harness_codex.runtime.changes.models import AffectedWorkItem, WorkItemType
from harness_codex.runtime.changes.work_item_documents import (
    missing_required_documents,
    planner_input_paths,
    scaffold_work_item_documents,
)


def maintenance_item() -> AffectedWorkItem:
    return AffectedWorkItem(
        work_item_id="MAINT-001",
        work_item_type=WorkItemType.MAINTENANCE,
        name="dispatcher worker tuning",
        impact_type="source-code",
        slice_path=Path("docs/maintenance/MAINT-001"),
    )


def test_maintenance_scaffold_creates_complete_typed_contract(tmp_path: Path) -> None:
    item = maintenance_item()

    created = scaffold_work_item_documents(tmp_path, item)

    expected = {
        Path("docs/maintenance/MAINT-001/brief.md"),
        Path("docs/maintenance/MAINT-001/scope.md"),
        Path("docs/maintenance/MAINT-001/change-intent.md"),
        Path("docs/maintenance/MAINT-001/maintenance-spec.md"),
        Path("docs/maintenance/MAINT-001/architecture-impact.md"),
        Path("docs/maintenance/MAINT-001/verification-goal.md"),
        Path("docs/maintenance/MAINT-001/links.md"),
    }
    assert set(created) == expected
    assert missing_required_documents(tmp_path, item) == ()

    scope = (tmp_path / "docs/maintenance/MAINT-001/scope.md").read_text(encoding="utf-8")
    assert "Bounded context:" in scope
    assert "Aggregate:" in scope
    assert "Application service:" in scope
    assert "Module or package:" in scope
    assert "Adapter or port:" in scope

    architecture_impact = (
        tmp_path / "docs/maintenance/MAINT-001/architecture-impact.md"
    ).read_text(encoding="utf-8")
    assert "`none` (`none` | `update` | `create` | `adr`)" in architecture_impact


def test_maintenance_planner_inputs_are_typed_and_never_include_uc_slice(tmp_path: Path) -> None:
    item = maintenance_item()
    scaffold_work_item_documents(tmp_path, item)

    inputs = planner_input_paths(
        tmp_path,
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        work_item=item,
    )

    assert Path("docs/changes/active/CHG-001.md") in inputs
    assert Path("docs/maintenance/MAINT-001/scope.md") in inputs
    assert Path("docs/maintenance/MAINT-001/architecture-impact.md") in inputs
    assert Path("docs/maintenance/MAINT-001/verification-goal.md") in inputs
    assert not any(str(path).startswith("docs/use-cases/") for path in inputs)


def test_maintenance_preflight_requires_scope_and_architecture_assessment(tmp_path: Path) -> None:
    item = maintenance_item()
    slice_dir = tmp_path / item.slice_path
    slice_dir.mkdir(parents=True)
    for filename in ("change-intent.md", "verification-goal.md"):
        (slice_dir / filename).write_text("# authored\n", encoding="utf-8")

    missing = set(missing_required_documents(tmp_path, item))

    assert Path("docs/maintenance/MAINT-001/scope.md") in missing
    assert Path("docs/maintenance/MAINT-001/maintenance-spec.md") in missing
    assert Path("docs/maintenance/MAINT-001/architecture-impact.md") in missing
    assert Path("docs/maintenance/MAINT-001/links.md") in missing
