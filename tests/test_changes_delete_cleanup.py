import json
from argparse import Namespace
from pathlib import Path

from harness_codex import cli
from harness_codex.runtime.changeset_cleanup import purge_changeset_runtime_artifacts


def test_changes_delete_removes_changeset_owned_runtime_artifacts(tmp_path: Path) -> None:
    change_set_id = "CHG-TEST-DELETE-001"
    active_change_set = tmp_path / "docs/changes/active" / f"{change_set_id}.md"
    active_change_set.parent.mkdir(parents=True)
    active_change_set.write_text(
        "\n".join(
            [
                f"# ChangeSet {change_set_id}",
                "",
                "|Field|Value|",
                "|---|---|",
                f"|ChangeSet ID|`{change_set_id}`|",
                "|Status|active|",
            ]
        ),
        encoding="utf-8",
    )

    sidecar_md = tmp_path / "docs/changes/active" / f"{change_set_id}.ddd-integration.md"
    sidecar_json = tmp_path / "docs/changes/active" / f"{change_set_id}.ddd-integration.json"
    sidecar_md.write_text("# 통합 설계\n", encoding="utf-8")
    sidecar_json.write_text(json.dumps({"change_set": change_set_id}), encoding="utf-8")

    stage_handoff = tmp_path / ".harness/state/stage-handoff" / f"{change_set_id}.json"
    stage_handoff.parent.mkdir(parents=True)
    stage_handoff.write_text(json.dumps({"change_set_id": change_set_id}), encoding="utf-8")

    stage_dir = tmp_path / ".harness/stages" / change_set_id
    stage_dir.mkdir(parents=True)
    (stage_dir / "requirements-definition.json").write_text("{}", encoding="utf-8")

    contracts_dir = tmp_path / ".harness/contracts" / change_set_id
    contracts_dir.mkdir(parents=True)
    (contracts_dir / "active_changeset.contract.json").write_text("{}", encoding="utf-8")

    canonical_run_dir = tmp_path / ".harness/runs" / f"changeset-state-{change_set_id}"
    canonical_run_dir.mkdir(parents=True)
    (canonical_run_dir / "state.json").write_text("{not json", encoding="utf-8")

    metadata_run_dir = tmp_path / ".harness/runs" / "interactive-ddd-test"
    metadata_run_dir.mkdir(parents=True)
    (metadata_run_dir / "metadata.json").write_text(
        json.dumps({"change_set": change_set_id}),
        encoding="utf-8",
    )

    ui_snapshot = tmp_path / ".harness/ui/change-sets" / change_set_id / "harvest-session.json"
    ui_snapshot.parent.mkdir(parents=True)
    ui_snapshot.write_text("{}", encoding="utf-8")

    persisted_job = tmp_path / ".harness/ui/stage-rerun-jobs" / f"{change_set_id}.json"
    persisted_job.parent.mkdir(parents=True)
    persisted_job.write_text("{}", encoding="utf-8")

    unscoped_harvest = tmp_path / ".harness/ui/harvest-session.json"
    unscoped_harvest.parent.mkdir(parents=True, exist_ok=True)
    unscoped_harvest.write_text("{}", encoding="utf-8")

    preserved_plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    preserved_plan.parent.mkdir(parents=True)
    preserved_plan.write_text(f"- ChangeSet: `{change_set_id}`\n", encoding="utf-8")

    output = cli.changes_delete_command(Namespace(change_set_id=change_set_id), tmp_path)

    assert output == f"DELETED: docs/changes/active/{change_set_id}.md"
    for removed_path in (
        active_change_set,
        sidecar_md,
        sidecar_json,
        stage_handoff,
        stage_dir,
        contracts_dir,
        canonical_run_dir,
        ui_snapshot,
        persisted_job,
        unscoped_harvest,
    ):
        assert not removed_path.exists()
    assert metadata_run_dir.exists()
    assert preserved_plan.exists()


def test_changeset_cleanup_rejects_invalid_changeset_id(tmp_path: Path) -> None:
    try:
        purge_changeset_runtime_artifacts(tmp_path, "../CHG-TEST")
    except ValueError as error:
        assert str(error) == "invalid ChangeSet id"
    else:
        raise AssertionError("invalid ChangeSet id accepted")
