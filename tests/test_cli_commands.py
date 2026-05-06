import json
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


def write_apply_smoke_fixture(repo: Path) -> None:
    write_changeset(repo)
    use_case_dir = repo / "docs/use-cases/UC-001"
    use_case_dir.mkdir(parents=True)
    for name in ("use-case.md", "event-storming.md", "e2e-goal.md"):
        (use_case_dir / name).write_text(name, encoding="utf-8")
    (repo / "ARCHITECTURE.md").write_text("architecture", encoding="utf-8")

    codex_dir = repo / ".codex"
    (codex_dir / "agents").mkdir(parents=True)
    (codex_dir / "skills").mkdir(parents=True)
    (codex_dir / "repository-settings.md").write_text("settings", encoding="utf-8")
    (codex_dir / "test-gate.yaml").write_text(
        "required:\n"
        "  - stage: unit\n"
        "    command: python3 -c 'print(\"ok\")'\n",
        encoding="utf-8",
    )
    for agent_id in ("implementation_planner", "implementation_executor"):
        (codex_dir / "agents" / f"{agent_id}.toml").write_text(
            "\n".join(
                [
                    f'name = "{agent_id}"',
                    'description = "smoke agent"',
                    'developer_instructions = """스모크 테스트"""',
                ]
            ),
            encoding="utf-8",
        )
    for skill_id in ("harness-code-planner", "harness-plan-executor"):
        skill_dir = codex_dir / "skills" / skill_id
        skill_dir.mkdir()
        (skill_dir / "SKILL.md").write_text(
            f"---\nname: {skill_id}\n---\n\n# {skill_id}\n",
            encoding="utf-8",
        )

    workflow_dir = repo / ".harness/workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "changeset-use-case-workflow.yaml").write_text(
        """
version: 1
workflow:
  name: changeset-use-case-workflow
  mode: apply
sandbox:
  kind: worktree
steps:
  - id: load-change-set
    kind: record
    inputs:
      - docs/changes/active
  - id: plan-work-item
    kind: agent
    needs: [load-change-set]
    agent_id: implementation_planner
    skill_id: harness-code-planner
  - id: execute-work-item
    kind: agent
    needs: [plan-work-item]
    agent_id: implementation_executor
    skill_id: harness-plan-executor
  - id: verify-work-item
    kind: validator
    needs: [execute-work-item]
    command: python3 -c 'print("ok")'
  - id: classify-verification-result
    kind: decision
    needs: [verify-work-item]
  - id: complete-work-item-plan
    kind: git
    needs: [classify-verification-result]
""".lstrip(),
        encoding="utf-8",
    )


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
    assert "Report: .harness/runs/" in output
    assert "State: .harness/runs/" in output
    run_dirs = list((tmp_path / ".harness/runs").iterdir())
    assert (run_dirs[0] / "state.json").is_file()
    assert (run_dirs[0] / "report.json").is_file()
    assert (run_dirs[0] / "report.md").is_file()

    report = json.loads((run_dirs[0] / "report.json").read_text(encoding="utf-8"))
    assert report["blocked_work_items"] == ["UC-001"]


def test_run_change_apply_smoke_records_agent_skill_invocations(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_apply_smoke_fixture(tmp_path)
    monkeypatch.setenv("HARNESS_CODEX_AGENT_ADAPTER", "recording")

    exit_code = main(
        ["--repo-root", str(tmp_path), "run-change", "CHG-001", "--apply"]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "status=succeeded" in output
    run_dir = next((tmp_path / ".harness/runs").iterdir())
    assert (tmp_path / "docs/plans/completed/UC-001/plan.md").is_file()

    planner_invocation = json.loads(
        (run_dir / "steps/plan-work-item/invocation.json").read_text(
            encoding="utf-8"
        )
    )
    executor_invocation = json.loads(
        (run_dir / "steps/execute-work-item/invocation.json").read_text(
            encoding="utf-8"
        )
    )
    assert planner_invocation["agent_id"] == "implementation_planner"
    assert planner_invocation["skill_id"] == "harness-code-planner"
    assert executor_invocation["agent_id"] == "implementation_executor"
    assert executor_invocation["skill_id"] == "harness-plan-executor"

    report = json.loads((run_dir / "report.json").read_text(encoding="utf-8"))
    assert report["completed_work_items"] == ["UC-001"]
    assert report["blocked_work_items"] == []

    main(["--repo-root", str(tmp_path), "dashboard"])
    dashboard = json.loads(capsys.readouterr().out)
    assert dashboard[0]["completed_work_items"] == ["UC-001"]

    main(["--repo-root", str(tmp_path), "resume", run_dir.name])
    assert "COMPLETE:" in capsys.readouterr().out


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
    dashboard = json.loads(output)
    assert dashboard[0]["blocked_work_items"] == ["MAINT-001"]
