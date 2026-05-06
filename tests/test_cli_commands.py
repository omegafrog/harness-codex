from pathlib import Path

from harness_codex.cli import main


CHANGESET = """# ChangeSet CHG-001

## 1. 메타데이터
|항목|값|
|---|---|
|ChangeSet ID|`CHG-001`|
|상태|active|

## 3. Before / After
|구분|내용|
|---|---|
|Before|old|
|After|new|

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

MAINT_CHANGESET = """# ChangeSet CHG-002

## 1. 메타데이터
|항목|값|
|---|---|
|ChangeSet ID|`CHG-002`|
|상태|active|

## 6. 영향 maintenance
|Maintenance ID|작업 이름|영향 유형|Slice 경로|상태|
|---|---|---|---|---|
|`MAINT-001`|테스트 게이트 정리|update|`docs/maintenance/MAINT-001/`|planned|
"""


def write_changeset(repo: Path) -> None:
    active_dir = repo / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-001.md").write_text(CHANGESET, encoding="utf-8")


def write_maintenance_changeset(repo: Path) -> None:
    active_dir = repo / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-002.md").write_text(MAINT_CHANGESET, encoding="utf-8")
    maint_dir = repo / "docs/maintenance/MAINT-001"
    maint_dir.mkdir(parents=True)
    for name in ("change-intent.md", "affected-files.md", "verification-goal.md"):
        (maint_dir / name).write_text(name, encoding="utf-8")


def test_changes_list_outputs_active_changesets(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)

    exit_code = main(["--repo-root", str(tmp_path), "changes", "list"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "CHG-001" in output
    assert "active" in output


def test_changes_show_outputs_affected_use_cases(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)

    exit_code = main(["--repo-root", str(tmp_path), "changes", "show", "CHG-001"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Affected UC: UC-001" in output
    assert "Before: old" in output


def test_run_change_plan_has_no_side_effects(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)

    exit_code = main(
        ["--repo-root", str(tmp_path), "run-change", "CHG-001", "--plan"]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Mode: plan" in output
    assert "Side effects: false" in output
    assert not (tmp_path / ".harness/runs").exists()


def test_run_use_case_preview_limits_to_selected_uc(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "run-use-case",
            "CHG-001",
            "UC-001",
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Mode: preview" in output
    assert "UC: UC-001" in output


def test_run_change_apply_creates_resume_state(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)

    exit_code = main(
        ["--repo-root", str(tmp_path), "run-change", "CHG-001", "--apply"]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "APPLY started" in output
    run_dirs = list((tmp_path / ".harness/runs").iterdir())
    assert (run_dirs[0] / "state.json").is_file()


def test_resume_reports_next_target(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)
    main(["--repo-root", str(tmp_path), "run-change", "CHG-001", "--apply"])
    capsys.readouterr()
    run_id = next((tmp_path / ".harness/runs").iterdir()).name

    exit_code = main(["--repo-root", str(tmp_path), "resume", run_id])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Resume: WAIT_FOR_ENVIRONMENT" in output
    assert "UC: UC-001" in output


def test_report_command_reads_report_markdown(tmp_path: Path, capsys) -> None:
    report_dir = tmp_path / ".harness/runs/run-001"
    report_dir.mkdir(parents=True)
    (report_dir / "report.md").write_text("# Run Report\n", encoding="utf-8")

    exit_code = main(["--repo-root", str(tmp_path), "report", "run-001"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "# Run Report" in output


def test_run_work_item_plan_outputs_maintenance_type(tmp_path: Path, capsys) -> None:
    write_maintenance_changeset(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "run-work-item",
            "CHG-002",
            "MAINT-001",
            "--plan",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Work item: MAINT-001" in output
    assert "Type: maintenance" in output
    assert "docs/plans/active/MAINT-001/plan.md" in output


def test_dashboard_outputs_work_item_state(tmp_path: Path, capsys) -> None:
    write_maintenance_changeset(tmp_path)
    main(["--repo-root", str(tmp_path), "run-change", "CHG-002", "--apply"])
    capsys.readouterr()

    exit_code = main(["--repo-root", str(tmp_path), "dashboard"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert '"id": "MAINT-001"' in output
    assert '"type": "maintenance"' in output
