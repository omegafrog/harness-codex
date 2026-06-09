import json
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import harness_codex.cli as cli
from harness_codex.cli import main
from harness_codex.runtime import FailureKind, RunMode, RunResult, RunStatus
from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    ChangeSet,
    PlanningInputScope,
)
from harness_codex.runtime.procedure_stages import render_initial_changeset


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
    write_use_case_slice(repo, "UC-001")


def write_use_case_slice(repo: Path, uc_id: str) -> None:
    use_case_dir = repo / "docs/use-cases" / uc_id
    use_case_dir.mkdir(parents=True)
    (use_case_dir / "use-case.md").write_text(
        f"# {uc_id}\n\n## Goal\n- Verify runtime planning scope.\n",
        encoding="utf-8",
    )
    (use_case_dir / "e2e-goal.md").write_text(
        f"# {uc_id} E2E Goal\n\n- Verify end-to-end behavior.\n",
        encoding="utf-8",
    )
    (use_case_dir / "event-storming.md").write_text(
        f"# {uc_id} Event Storming\n",
        encoding="utf-8",
    )
    (use_case_dir / "ddd-design.md").write_text(
        f"# {uc_id} DDD Design\n",
        encoding="utf-8",
    )
    (use_case_dir / "technical-decisions.md").write_text(
        f"""# {uc_id}. Technical Decisions

## 1. Metadata
|Item|Value|
|---|---|
|ChangeSet|CHG-001|
|Use Case|{uc_id}|
|Approval Status|approved|

## 7. Pending Decisions
- None
""",
        encoding="utf-8",
    )
    (use_case_dir / "affected-files.md").write_text(
        f"# {uc_id} Affected Files\n",
        encoding="utf-8",
    )
    plan_dir = repo / "docs/plans/active" / uc_id
    plan_dir.mkdir(parents=True)
    (plan_dir / "plan.md").write_text(
        f"# {uc_id} Plan\n\n- [ ] Verify runtime implementation stage.\n",
        encoding="utf-8",
    )


def write_maintenance_changeset(repo: Path) -> None:
    active_dir = repo / "docs/changes/active"
    active_dir.mkdir(parents=True)
    (active_dir / "CHG-002.md").write_text(MAINT_CHANGESET, encoding="utf-8")
    maint_dir = repo / "docs/maintenance/MAINT-001"
    maint_dir.mkdir(parents=True)
    for name in ("change-intent.md", "affected-files.md", "verification-goal.md"):
        (maint_dir / name).write_text(name, encoding="utf-8")


def write_design_docs(repo: Path) -> None:
    design_dir = repo / "docs/design"
    design_dir.mkdir(parents=True)
    (design_dir / "요구사항.md").write_text(
        """# Requirements Specification

## 1. Overview
- Initial idea: simple calculator app
- Goal: Let a user calculate arithmetic results.

## 3. Functional Requirements
### 3.1 Calculator Operations
- FR-001. The system shall add, subtract, multiply, and divide numbers.
- FR-002. The system shall reject invalid numeric input.
- FR-003. The system shall reject division by zero.
""",
        encoding="utf-8",
    )
    (design_dir / "유스케이스.md").write_text(
        """# Use Case Document

## 1. Actor Definition
### Primary Actor
- User

## 2. High-Level Use Case List
### User
- UC-01. User performs calculator operations

## 3. Use Case Details
## UC-01. User performs calculator operations
**Actor**
- User

**Goal**
- Calculate addition, subtraction, multiplication, and division results.

**Basic Flow**
1. The user enters two numbers and selects an operation.
2. The system validates the inputs.
3. The system displays the result.

**Exception Flow**
- Invalid numeric input is rejected.
- Division by zero is rejected.
""",
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


def test_changes_delete_removes_active_changeset(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)

    exit_code = main(["--repo-root", str(tmp_path), "changes", "delete", "CHG-001"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "DELETED: docs/changes/active/CHG-001.md" in output
    assert not (tmp_path / "docs/changes/active/CHG-001.md").exists()


def test_changes_delete_reports_missing_active_changeset(
    tmp_path: Path,
    capsys,
) -> None:
    exit_code = main(["--repo-root", str(tmp_path), "changes", "delete", "CHG-999"])

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "Active ChangeSet file not found: docs/changes/active/CHG-999.md" in captured.err


def test_legacy_workflow_commands_are_not_registered(tmp_path: Path) -> None:
    legacy_invocations = (
        ["--repo-root", str(tmp_path), "harvest", "--plan"],
        ["--repo-root", str(tmp_path), "run-change", "CHG-001", "--plan"],
        ["--repo-root", str(tmp_path), "run-use-case", "CHG-001", "UC-001", "--preview"],
        ["--repo-root", str(tmp_path), "run-work-item", "CHG-001", "UC-001", "--preview"],
        ["--repo-root", str(tmp_path), "run-stage", "CHG-001", "requirements", "--plan"],
        ["--repo-root", str(tmp_path), "changes", "create-from-design"],
    )

    for argv in legacy_invocations:
        with pytest.raises(SystemExit) as exc:
            main(argv)
        assert exc.value.code == 2


def test_agent_context_init_creates_expected_files(
    tmp_path: Path,
    capsys,
) -> None:
    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "agent-context",
            "init",
            "--description",
            "sample project",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Agent context:" in output
    assert "AGENTS.md: created" in output
    assert "docs/agent/context.md: created" in output
    assert (tmp_path / "AGENTS.md").is_file()
    assert (tmp_path / "docs/agent/token-reduction-report.md").is_file()


def test_init_creates_expected_files_without_llm(
    tmp_path: Path,
    capsys,
) -> None:
    (tmp_path / "package.json").write_text(
        '{"scripts":{"test":"vitest","build":"vite build"}}\n',
        encoding="utf-8",
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "init",
            "--description",
            "sample app",
            "--no-llm",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Agent context:" in output
    assert "LLM summary: skipped" in output
    commands = (tmp_path / "docs/agent/commands.md").read_text(encoding="utf-8")
    assert "npm run test" in commands
    assert "npm run build" in commands


def test_init_falls_back_when_llm_blocks(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    from harness_codex.runtime.repo_analyzer import LlmRepoSummary

    monkeypatch.setattr(
        "harness_codex.runtime.agent_context.summarize_repository_with_llm",
        lambda *_args, **_kwargs: LlmRepoSummary(status="blocked", error="quota"),
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "init",
            "--description",
            "sample app",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "LLM summary: blocked" in output
    assert "LLM error: quota" in output
    assert (tmp_path / "docs/agent/context.md").is_file()


def test_changes_document_delta_preview_has_no_side_effects(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)
    target = tmp_path / "docs/use-cases/UC-001/technical-decisions.md"
    target.write_text("# Technical Decisions\n", encoding="utf-8")

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "document-delta",
            "CHG-001",
            "--uc",
            "UC-001",
            "--summary",
            "Approve minimal reload read contract.",
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Side effects: false" in output
    assert "Approve minimal reload read contract." not in target.read_text(encoding="utf-8")


def test_changes_document_delta_patches_target_doc_and_active_plan(
    tmp_path: Path,
    capsys,
) -> None:
    write_changeset(tmp_path)
    target = tmp_path / "docs/use-cases/UC-001/technical-decisions.md"
    target.write_text("# Technical Decisions\n", encoding="utf-8")
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True, exist_ok=True)
    plan.write_text("# Plan\n", encoding="utf-8")

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "document-delta",
            "CHG-001",
            "--uc",
            "UC-001",
            "--summary",
            "Approve minimal reload read contract.",
            "--plan-note",
            "Add one GET reload task.",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "APPLIED document delta" in output
    assert "Approve minimal reload read contract." in target.read_text(encoding="utf-8")
    assert "Add one GET reload task." in plan.read_text(encoding="utf-8")


def test_ultrawork_creates_changeset_and_runs_all_workflows(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_design_docs(tmp_path)
    stage_calls = []

    def fake_procedure_stage_command(args, repo_root):
        stage_calls.append((args.procedure_stage_id, args.change_set_id, args.uc, args.apply))
        return "\n".join(
            [
                f"Stage: {args.procedure_stage_id}",
                "Agent status: succeeded",
                "Verification: passed",
                "ChangeSet status: verified",
            ]
        )

    def fake_run_change_command(args, repo_root):
        assert args.change_set_id == "CHG-20260507-001"
        assert args.apply is True
        return "APPLY started: run_id=run-test status=succeeded active_changeset_moved=false"

    monkeypatch.setattr(cli, "procedure_stage_command", fake_procedure_stage_command)
    monkeypatch.setattr(cli, "run_change_command", fake_run_change_command)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "ultrawork",
            "--title",
            "simple calculator app",
            "--change-set-id",
            "CHG-20260507-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "CREATED: CHG-20260507-001" in output
    assert "Workflow run:" in output
    assert "APPLY started:" in output
    assert (tmp_path / "docs/changes/active/CHG-20260507-001.md").is_file()
    assert (tmp_path / "docs/use-cases/UC-001/use-case.md").is_file()
    assert stage_calls == [
        ("event-storming", "CHG-20260507-001", "UC-001", True),
        ("ddd-architecture-definition", "CHG-20260507-001", "UC-001", True),
        ("technical-decisions", "CHG-20260507-001", "UC-001", True),
    ]


def test_ultrawork_preview_creates_changeset_without_starting_run(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_design_docs(tmp_path)

    def fake_procedure_stage_command(args, repo_root):
        return "\n".join(
            [
                f"Stage: {args.procedure_stage_id}",
                "Verification: passed",
            ]
        )

    def fake_run_change_command(args, repo_root):
        assert args.preview is True
        return "Mode: preview\nChangeSet: CHG-20260507-001\nSide effects: false"

    monkeypatch.setattr(cli, "procedure_stage_command", fake_procedure_stage_command)
    monkeypatch.setattr(cli, "run_change_command", fake_run_change_command)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "ultrawork",
            "--title",
            "simple calculator app",
            "--change-set-id",
            "CHG-20260507-001",
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "CREATED: CHG-20260507-001" in output
    assert "Workflow run:" in output
    assert "Mode: preview" in output
    assert not (tmp_path / ".harness/runs").exists()


def test_apply_workflow_reports_each_use_case_before_and_after_execution(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    change_set, scopes = _workflow_feedback_fixture()
    results = iter(
        (
            RunResult("run-test", RunStatus.SUCCEEDED, (), mode=RunMode.APPLY),
            RunResult("run-test", RunStatus.SUCCEEDED, (), mode=RunMode.APPLY),
        )
    )
    _stub_workflow_execution(monkeypatch, results)

    cli._apply_workflow(tmp_path, change_set, scopes)

    assert capsys.readouterr().out.splitlines() == [
        "Use case execution start: UC-001 - Capture a fleeting note (1/2)",
        "Use case execution result: UC-001 - Capture a fleeting note status=succeeded",
        "Use case execution start: UC-002 - Revise a fleeting note (2/2)",
        "Use case execution result: UC-002 - Revise a fleeting note status=succeeded",
    ]


def test_apply_workflow_reports_failure_details_and_stops_next_use_case(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    change_set, scopes = _workflow_feedback_fixture()
    results = iter(
        (
            RunResult(
                "run-test",
                RunStatus.BLOCKED,
                (),
                mode=RunMode.APPLY,
                failed_step_id="verify-work-item",
                failure_kind=FailureKind.ENVIRONMENT_BLOCKER,
                blocker="test database unavailable",
            ),
        )
    )
    _stub_workflow_execution(monkeypatch, results)

    cli._apply_workflow(tmp_path, change_set, scopes)

    assert capsys.readouterr().out.splitlines() == [
        "Use case execution start: UC-001 - Capture a fleeting note (1/2)",
        (
            "Use case execution result: UC-001 - Capture a fleeting note status=blocked "
            "failed_step=verify-work-item failure_kind=environment_blocker "
            "blocker=test database unavailable"
        ),
    ]


def _workflow_feedback_fixture() -> tuple[ChangeSet, tuple[PlanningInputScope, ...]]:
    use_cases = tuple(
        AffectedUseCase(
            uc_id=uc_id,
            name=name,
            impact_type="update",
            slice_path=Path("docs/use-cases") / uc_id,
        )
        for uc_id, name in (
            ("UC-001", "Capture a fleeting note"),
            ("UC-002", "Revise a fleeting note"),
        )
    )
    change_set = ChangeSet(
        change_set_id="CHG-001",
        title="Runtime feedback",
        path=Path("docs/changes/active/CHG-001.md"),
        affected_use_cases=use_cases,
    )
    scopes = tuple(
        PlanningInputScope(
            change_set_path=change_set.path,
            use_case=use_case,
            planner_inputs=(),
            executor_inputs=(),
            e2e_goal_path=use_case.slice_path / "e2e-goal.md",
            work_item_id=use_case.uc_id,
            plan_path=Path("docs/plans/active") / use_case.uc_id / "plan.md",
            verification_goal_path=use_case.slice_path / "e2e-goal.md",
        )
        for use_case in use_cases
    )
    return change_set, scopes


def _stub_workflow_execution(monkeypatch, results) -> None:
    workflow = SimpleNamespace(name="changeset-use-case-workflow")

    class FakeRunnerEngine:
        def __init__(self, _step_runner) -> None:
            pass

        def run(self, _workflow, _context):
            return next(results)

    monkeypatch.setattr(cli, "load_named_workflow", lambda *_args, **_kwargs: workflow)
    monkeypatch.setattr(
        cli,
        "materialize_workflow_for_scope",
        lambda _workflow, _change_set, _scope: workflow,
    )
    monkeypatch.setattr(cli, "write_materialized_workflow_manifest", lambda *_args: None)
    monkeypatch.setattr(cli, "RunnerEngine", FakeRunnerEngine)


class FakeDateTime:
    @classmethod
    def now(cls):
        class _Now:
            def strftime(self, fmt: str) -> str:
                return "20260507"

        return _Now()


def _complete_stage_json(*_args) -> str:
    return json.dumps(
        {
            "status": "complete",
            "questions": [],
            "changed_files": [],
            "blocker": "",
        }
    )


def test_requirements_definition_finalizes_temporary_changeset_without_id(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    def complete_requirements_stage(*_args) -> str:
        design_dir = tmp_path / "docs/design"
        design_dir.mkdir(parents=True, exist_ok=True)
        (design_dir / "요구사항.md").write_text(
            "---\n"
            "change_set_id: CHG-TEMP-20260507-001\n"
            "doc_id: \"CHG-TEMP-20260507-001:requirements\"\n"
            "source_docs:\n"
            "  - docs/changes/active/CHG-TEMP-20260507-001.md\n"
            "---\n"
            "# Requirements\n\n"
            "- Initial idea: simple calculator app.\n",
            encoding="utf-8",
        )
        return _complete_stage_json()

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", complete_requirements_stage)
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))
    monkeypatch.setattr(cli, "datetime", FakeDateTime)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "requirements-definition",
            "--idea",
            "Build note capture",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Stage: requirements-definition" in output
    assert "Finalized ChangeSet: CHG-TEMP-20260507-001 -> CHG-20260507-001" in output
    temp_path = tmp_path / "docs/changes/active/CHG-TEMP-20260507-001.md"
    final_path = tmp_path / "docs/changes/active/CHG-20260507-001.md"
    assert not temp_path.exists()
    assert final_path.is_file()
    final_text = final_path.read_text(encoding="utf-8")
    assert "# simple calculator app\n" in final_text
    assert "|ChangeSet ID|`CHG-20260507-001`|" in final_text
    assert "- Request summary: simple calculator app" in final_text
    assert "|requirements-definition|Requirements Definition|verified|" in final_text
    assert "CHG-TEMP-20260507-001" not in final_text
    requirements_text = (tmp_path / "docs/design/요구사항.md").read_text(
        encoding="utf-8"
    )
    assert "change_set_id: CHG-20260507-001" in requirements_text
    assert "doc_id: \"CHG-20260507-001:requirements\"" in requirements_text
    assert "docs/changes/active/CHG-20260507-001.md" in requirements_text
    assert "CHG-TEMP-20260507-001" not in requirements_text


def test_requirements_definition_uses_requirements_title_when_temp_changeset_is_generic(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    def complete_requirements_stage(*_args) -> str:
        design_dir = tmp_path / "docs/design"
        design_dir.mkdir(parents=True, exist_ok=True)
        (design_dir / "요구사항.md").write_text(
            "# Requirements\n\n"
            "- Initial idea: Build an AI-assisted Zettelkasten note-writing service.\n",
            encoding="utf-8",
        )
        return _complete_stage_json()

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", complete_requirements_stage)
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))
    monkeypatch.setattr(cli, "datetime", FakeDateTime)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "requirements-definition",
            "--idea",
            "CHG-TEMP-20260507-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    final_path = tmp_path / "docs/changes/active/CHG-20260507-001.md"
    final_text = final_path.read_text(encoding="utf-8")
    assert exit_code == 0
    assert "Finalized ChangeSet: CHG-TEMP-20260507-001 -> CHG-20260507-001" in output
    assert "# Build an AI-assisted Zettelkasten note-writing service\n" in final_text
    assert (
        "- Request summary: Build an AI-assisted Zettelkasten note-writing service"
        in final_text
    )
    assert "CHG-TEMP-20260507-001" not in final_text


def test_requirements_definition_keeps_temporary_changeset_without_requirements_doc(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", _complete_stage_json)
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))
    monkeypatch.setattr(cli, "datetime", FakeDateTime)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "requirements-definition",
            "--idea",
            "Build note capture",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Finalized ChangeSet" not in output
    temp_path = tmp_path / "docs/changes/active/CHG-TEMP-20260507-001.md"
    assert temp_path.is_file()
    assert "|ChangeSet ID|`CHG-TEMP-20260507-001`|" in temp_path.read_text(
        encoding="utf-8"
    )


def test_use_case_definition_finalizes_temporary_changeset_from_design(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_design_docs(tmp_path)
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True)
    temp_path = active_dir / "CHG-TEMP-20260507-001.md"
    temp_path.write_text(
        render_initial_changeset(
            change_set_id="CHG-TEMP-20260507-001",
            title="temporary",
            request_summary="Build note capture",
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", _complete_stage_json)
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))
    monkeypatch.setattr(cli, "datetime", FakeDateTime)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "use-case-definition",
            "CHG-TEMP-20260507-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    final_path = tmp_path / "docs/changes/active/CHG-20260507-001.md"
    assert exit_code == 0
    assert "Finalized ChangeSet: CHG-TEMP-20260507-001 -> CHG-20260507-001" in output
    assert not temp_path.exists()
    assert final_path.is_file()
    final_text = final_path.read_text(encoding="utf-8")
    assert "# simple calculator app\n" in final_text
    assert "|ChangeSet ID|`CHG-20260507-001`|" in final_text
    assert "|use-case-definition|Use Case Definition|verified|" in final_text
    assert "CHG-TEMP-20260507-001" not in final_text


def test_procedure_stage_plan_has_no_side_effects(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "event-storming",
            "CHG-001",
            "--uc",
            "UC-001",
            "--plan",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Stage: event-storming" in output
    assert not (tmp_path / ".harness/runs").exists()


def test_use_case_definition_plan_limits_outputs_to_selected_uc(
    tmp_path: Path,
    capsys,
) -> None:
    write_changeset(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "use-case-definition",
            "CHG-001",
            "--uc",
            "UC-001",
            "--plan",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "docs/design/유스케이스.md" in output
    assert "docs/use-cases/UC-001/use-case.md" in output
    assert "docs/use-cases/UC-001/e2e-goal.md" in output
    assert "- docs/use-cases\n" not in output
    assert not (tmp_path / ".harness/runs").exists()


def test_procedure_stage_preview_limits_to_selected_uc(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "event-storming",
            "CHG-001",
            "--uc",
            "UC-001",
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Stage: event-storming" in output
    assert "Verification: passed" in output


def test_changes_continue_routes_use_case_upstream_blocker_to_requirements(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    text = change_set_path.read_text(encoding="utf-8")
    text = cli.update_changeset_stage_status(
        text,
        stage=cli.procedure_stage("requirements-definition"),
        status="verified",
        notes="existing requirements",
    )
    text = cli.update_changeset_stage_status(
        text,
        stage=cli.procedure_stage("use-case-definition"),
        status="blocked",
        notes="Requirements do not define what approval saves.",
    )
    change_set_path.write_text(text, encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_procedure_stage_command(args, _repo_root):
        captured["stage"] = args.procedure_stage_id
        captured["force"] = args.force
        captured["apply"] = args.apply
        return "stage command called"

    monkeypatch.setattr(cli, "procedure_stage_command", fake_procedure_stage_command)
    monkeypatch.setattr("builtins.input", lambda _prompt="": "1")

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "continue",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Target stage: requirements-definition" in output
    assert "user chose to supplement upstream requirements" in output
    assert captured == {
        "stage": "requirements-definition",
        "force": True,
        "apply": True,
    }


def test_changes_continue_updates_use_case_with_user_prompt(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    text = change_set_path.read_text(encoding="utf-8")
    text = cli.update_changeset_stage_status(
        text,
        stage=cli.procedure_stage("requirements-definition"),
        status="verified",
        notes="existing requirements",
    )
    text = cli.update_changeset_stage_status(
        text,
        stage=cli.procedure_stage("use-case-definition"),
        status="blocked",
        notes="Requirements do not define what approval saves.",
    )
    change_set_path.write_text(text, encoding="utf-8")
    captured: dict[str, object] = {}
    answers = iter(["2", "Add approval retention details to current use-case artifacts."])

    def fake_procedure_stage_command(args, _repo_root):
        captured["stage"] = args.procedure_stage_id
        captured["force"] = args.force
        captured["idea"] = args.idea
        return "stage command called"

    monkeypatch.setattr(cli, "procedure_stage_command", fake_procedure_stage_command)
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(answers))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "continue",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Target stage: use-case-definition" in output
    assert "user chose to update current use-case artifacts" in output
    assert captured == {
        "stage": "use-case-definition",
        "force": True,
        "idea": "Add approval retention details to current use-case artifacts.",
    }


def test_changes_continue_preview_reports_use_case_blocker_choices(
    tmp_path: Path,
    capsys,
) -> None:
    write_changeset(tmp_path)
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    text = cli.update_changeset_stage_status(
        change_set_path.read_text(encoding="utf-8"),
        stage=cli.procedure_stage("use-case-definition"),
        status="blocked",
        notes="Requirements missing approval behavior.",
    )
    change_set_path.write_text(text, encoding="utf-8")

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "continue",
            "CHG-001",
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "needs user resolution" in output
    assert "--blocker-resolution requirements" in output
    assert "--blocker-resolution use-case --resolution-prompt TEXT" in output


def test_changes_continue_retries_use_case_after_requirements_rerun(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    text = change_set_path.read_text(encoding="utf-8")
    text = cli.update_changeset_stage_status(
        text,
        stage=cli.procedure_stage("requirements-definition"),
        status="verified",
        notes="updated requirements decision",
    )
    text = cli.update_changeset_stage_status(
        text,
        stage=cli.procedure_stage("use-case-definition"),
        status="blocked",
        notes="Requirements do not define what approval saves.",
    )
    text = re.sub(
        r"\|requirements-definition\|Requirements Definition\|verified\|[^|]+\|",
        "|requirements-definition|Requirements Definition|verified|2026-01-02T00:00:00Z|",
        text,
    )
    text = re.sub(
        r"\|use-case-definition\|Use Case Definition\|blocked\|[^|]+\|",
        "|use-case-definition|Use Case Definition|blocked|2026-01-01T00:00:00Z|",
        text,
    )
    change_set_path.write_text(text, encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_procedure_stage_command(args, _repo_root):
        captured["stage"] = args.procedure_stage_id
        captured["force"] = args.force
        return "stage command called"

    monkeypatch.setattr(cli, "procedure_stage_command", fake_procedure_stage_command)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "continue",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Target stage: use-case-definition" in output
    assert "requirements-definition was rerun" in output
    assert captured == {
        "stage": "use-case-definition",
        "force": True,
    }


def test_changes_continue_runs_next_incomplete_stage(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    text = cli.update_changeset_stage_status(
        change_set_path.read_text(encoding="utf-8"),
        stage=cli.procedure_stage("requirements-definition"),
        status="verified",
        notes="existing requirements",
    )
    change_set_path.write_text(text, encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_procedure_stage_command(args, _repo_root):
        captured["stage"] = args.procedure_stage_id
        captured["force"] = args.force
        captured["preview"] = args.preview
        return "stage command called"

    monkeypatch.setattr(cli, "procedure_stage_command", fake_procedure_stage_command)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "continue",
            "CHG-001",
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Target stage: ubiquitous-language-definition" in output
    assert "next incomplete stage" in output
    assert captured == {
        "stage": "ubiquitous-language-definition",
        "force": False,
        "preview": True,
    }


def test_changes_continue_reruns_blocked_uc_scoped_stage(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    text = change_set_path.read_text(encoding="utf-8")
    for stage_id in (
        "requirements-definition",
        "ubiquitous-language-definition",
        "use-case-definition",
    ):
        text = cli.update_changeset_stage_status(
            text,
            stage=cli.procedure_stage(stage_id),
            status="verified",
            notes=f"{stage_id} complete",
        )
    text = cli.update_changeset_stage_status(
        text,
        stage=cli.procedure_stage("event-storming"),
        status="blocked",
        notes="event storming needs rerun",
    )
    change_set_path.write_text(text, encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_procedure_stage_command(args, _repo_root):
        captured["stage"] = args.procedure_stage_id
        captured["uc"] = args.uc
        captured["force"] = args.force
        return "stage command called"

    monkeypatch.setattr(cli, "procedure_stage_command", fake_procedure_stage_command)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "continue",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Target stage: event-storming" in output
    assert "UC: UC-001" in output
    assert captured == {
        "stage": "event-storming",
        "uc": "UC-001",
        "force": True,
    }


def test_interactive_grill_me_stages_use_shared_runner(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    calls: list[str] = []
    review_calls: list[str] = []

    def fake_exec(_root, _step_dir, prompt, _label):
        calls.append(prompt)
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": ["draft.md"],
                "blocker": "",
            }
        )

    def fake_review_exec(_root, _step_dir, prompt, _label):
        review_calls.append(prompt)
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "review_file": ".harness/runs/run-test/reviews/review.md",
                "findings": [],
                "blocker": "",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_exec)
    monkeypatch.setattr(cli, "_exec_stage_review_prompt", fake_review_exec)
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))

    commands = (
        ["requirements-definition", "CHG-001", "--apply"],
        ["ubiquitous-language-definition", "CHG-001", "--apply"],
        ["use-case-definition", "CHG-001", "--apply"],
        ["event-storming", "CHG-001", "--uc", "UC-001", "--apply"],
    )

    for command in commands:
        exit_code = main(["--repo-root", str(tmp_path), *command])
        output = capsys.readouterr().out
        assert exit_code == 0
        assert "Interactive status: complete" in output
        assert "ChangeSet status: verified" in output

    assert len(calls) == 4
    assert len(review_calls) == 3
    assert all("Return only JSON with keys: status, questions, changed_files, blocker" in prompt for prompt in calls)
    assert all("artifact_reviewer" in prompt for prompt in review_calls)
    assert "Do not ask whether a domain object, note type, source rule, MVP policy" in calls[1]
    assert "If upstream requirements omit or contradict a decision needed for language confirmation" in calls[1]
    assert "Ask only when canonical wording, labels, aliases, forbidden terms, or exact term meaning are unclear" in calls[1]
    assert "This stage may ask Grill-Me questions only to clarify ubiquitous language" in calls[1]
    assert "After writing `context.md`, do not run extra verification tool calls" in calls[1]
    assert "Which canonical term should represent an approved saved link between notes?" in calls[1]


def test_verified_interactive_stage_skips_nested_agent(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    (tmp_path / "docs/design").mkdir(parents=True, exist_ok=True)
    (tmp_path / "docs/design/요구사항.md").write_text(
        "# Requirements\n\n- Existing verified requirements.\n",
        encoding="utf-8",
    )
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    change_set_path.write_text(
        cli.update_changeset_stage_status(
            change_set_path.read_text(encoding="utf-8"),
            stage=cli.procedure_stage("requirements-definition"),
            status="verified",
            notes="existing verification",
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(
        cli,
        "_exec_stage_grill_me_prompt",
        lambda *_args: pytest.fail("already verified stage must not rerun nested agent"),
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "requirements-definition",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Run: -" in output
    assert "ChangeSet status: verified" in output
    assert "already verified" in output


def test_interactive_grill_me_answers_are_saved_and_passed_to_next_turn(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    prompts: list[str] = []
    answers = iter(["actor answer", "goal answer", "policy answer"])

    def fake_exec(_root, _step_dir, prompt, _label):
        prompts.append(prompt)
        if len(prompts) == 1:
            return json.dumps(
                {
                    "status": "needs_input",
                    "questions": [
                        {"question": "Who is the actor?", "recommended": "User"},
                        {"question": "What goal matters?", "recommended": "Complete task"},
                        {"question": "What policy applies?", "recommended": "Reject invalid input"},
                    ],
                    "changed_files": ["docs/design/요구사항.md"],
                    "blocker": "",
                }
            )
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": ["docs/design/요구사항.md"],
                "blocker": "",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_exec)
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(answers))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "requirements-definition",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "requirements-definition Grill-Me questions:" in output
    assert "Recommended answer: User" in output
    assert "actor answer" in prompts[1]
    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert [item["answer"] for item in session["answers"]] == [
        "actor answer",
        "goal answer",
        "policy answer",
    ]


def test_interactive_content_review_questions_rerun_stage_agent(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    stage_prompts: list[str] = []
    review_calls = 0
    answers = iter(["use actor-visible success"])

    def fake_exec(_root, _step_dir, prompt, _label):
        stage_prompts.append(prompt)
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": ["docs/design/요구사항.md"],
                "blocker": "",
            }
        )

    def fake_review_exec(_root, _step_dir, _prompt, _label):
        nonlocal review_calls
        review_calls += 1
        if review_calls == 1:
            return json.dumps(
                {
                    "status": "needs_input",
                    "questions": [
                        {
                            "question": "Which success condition should govern the requirement?",
                            "recommended": "Use the actor-visible success condition.",
                        }
                    ],
                    "review_file": ".harness/runs/run-test/reviews/requirements-definition-content-review.md",
                    "findings": ["Success condition is ambiguous."],
                    "blocker": "",
                }
            )
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "review_file": ".harness/runs/run-test/reviews/requirements-definition-content-review.md",
                "findings": [],
                "blocker": "",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_exec)
    monkeypatch.setattr(cli, "_exec_stage_review_prompt", fake_review_exec)
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(answers))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "requirements-definition",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Content review: complete" in output
    assert review_calls == 2
    assert len(stage_prompts) == 2
    assert "use actor-visible success" in stage_prompts[1]
    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["answers"][0]["source"] == "content_review"
    assert session["reviews"][0]["status"] == "needs_input"


def test_interactive_content_review_blocked_reruns_stage_agent(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    stage_prompts: list[str] = []
    review_calls = 0

    def fake_exec(_root, _step_dir, prompt, _label):
        stage_prompts.append(prompt)
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": ["docs/design/요구사항.md"],
                "blocker": "",
            }
        )

    def fake_review_exec(_root, _step_dir, _prompt, _label):
        nonlocal review_calls
        review_calls += 1
        if review_calls == 1:
            return json.dumps(
                {
                    "status": "blocked",
                    "questions": [],
                    "review_file": ".harness/runs/run-test/reviews/requirements-definition-content-review.md",
                    "findings": ["Stage-boundary violation remains."],
                    "blocker": "Requirements include downstream technical decisions.",
                }
            )
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "review_file": ".harness/runs/run-test/reviews/requirements-definition-content-review.md",
                "findings": [],
                "blocker": "",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_exec)
    monkeypatch.setattr(cli, "_exec_stage_review_prompt", fake_review_exec)
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "requirements-definition",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Content review: complete" in output
    assert review_calls == 2
    assert len(stage_prompts) == 2
    assert "Stage-boundary violation remains." in stage_prompts[1]
    assert "Requirements include downstream technical decisions." in stage_prompts[1]
    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["review_feedback"][0]["status"] == "blocked"
    assert session["reviews"][0]["status"] == "blocked"


def test_ubiquitous_language_skips_content_review_after_completion(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)

    def fake_exec(_root, _step_dir, prompt, _label):
        assert "This stage may ask Grill-Me questions only to clarify ubiquitous language" in prompt
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": ["context.md"],
                "blocker": "",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_exec)
    monkeypatch.setattr(
        cli,
        "_exec_stage_review_prompt",
        lambda *_args: pytest.fail("ubiquitous language stage must not run LLM content review"),
    )
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "ubiquitous-language-definition",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Content review:" not in output
    assert "ChangeSet status: verified" in output
    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["reviews"] == []


def test_ubiquitous_language_stage_asks_language_questions(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    prompts: list[str] = []
    answers = iter(["Use Literature Note as the canonical term."])

    def fake_exec(_root, _step_dir, prompt, _label):
        prompts.append(prompt)
        if len(prompts) == 1:
            return json.dumps(
                {
                    "status": "needs_input",
                    "questions": [
                        {
                            "question": "Which label should be canonical?",
                            "recommended": "Use Literature Note.",
                        }
                    ],
                    "changed_files": ["context.md"],
                    "blocker": "",
                }
            )
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": ["context.md"],
                "blocker": "",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_exec)
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, ()))
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(answers))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "ubiquitous-language-definition",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: complete" in output
    assert "Which label should be canonical?" in output
    assert "Use Literature Note as the canonical term." in prompts[1]
    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["answers"][0]["question"] == "Which label should be canonical?"
    assert session["turns"][0]["status"] == "needs_input"


def test_ubiquitous_language_stage_blocks_requirement_questions_without_user_input(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)

    monkeypatch.setattr(
        cli,
        "_exec_stage_grill_me_prompt",
        lambda *_args: json.dumps(
            {
                "status": "needs_input",
                "questions": [
                    {
                        "question": "Must a Literature Note remain tied to identified grounding material?",
                        "recommended": "Require ongoing grounding-material ties.",
                    }
                ],
                "changed_files": ["context.md"],
                "blocker": "",
            }
        ),
    )
    monkeypatch.setattr("builtins.input", lambda _prompt="": pytest.fail("input must not be called"))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "ubiquitous-language-definition",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: blocked" in output
    assert "outside ubiquitous-language clarification boundary" in output
    assert "Literature Note remain tied" not in output


def test_interactive_grill_me_blocked_records_blocker(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)

    monkeypatch.setattr(
        cli,
        "_exec_stage_grill_me_prompt",
        lambda *_args: json.dumps(
            {
                "status": "blocked",
                "questions": [],
                "changed_files": [],
                "blocker": "requirements contradict actor goal",
            }
        ),
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "use-case-definition",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: blocked" in output
    assert "requirements contradict actor goal" in output
    assert "requirements contradict actor goal" in (
        tmp_path / "docs/changes/active/CHG-001.md"
    ).read_text(encoding="utf-8")


def test_exec_stage_grill_me_prompt_uses_one_hour_timeout_by_default(
    tmp_path: Path,
    monkeypatch,
) -> None:
    observed: dict[str, object] = {}
    monkeypatch.delenv("HARNESS_CODEX_EXEC_TIMEOUT_SECONDS", raising=False)

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        observed["timeout"] = kwargs["timeout"]
        observed["input"] = kwargs["input"]
        final_message_path = Path(command[command.index("--output-last-message") + 1])
        final_message_path.write_text('{"status":"complete"}', encoding="utf-8")
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(cli.subprocess, "run", fake_run)

    output = cli._exec_stage_grill_me_prompt(
        tmp_path,
        tmp_path / ".harness/runs/run-test/turn-01",
        "prompt text",
        "use-case-definition Grill-Me turn",
    )

    assert observed["timeout"] == 3600
    assert observed["input"] == "prompt text"
    assert output == '{"status":"complete"}'


def test_exec_stage_grill_me_prompt_reports_configured_timeout(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("HARNESS_CODEX_EXEC_TIMEOUT_SECONDS", "7")

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        raise subprocess.TimeoutExpired(command, timeout=kwargs["timeout"])

    monkeypatch.setattr(cli.subprocess, "run", fake_run)

    step_dir = tmp_path / ".harness/runs/run-test/turn-01"
    with pytest.raises(ValueError, match="use-case-definition Grill-Me turn timed out after 7 seconds"):
        cli._exec_stage_grill_me_prompt(
            tmp_path,
            step_dir,
            "prompt text",
            "use-case-definition Grill-Me turn",
        )

    assert "timed out after 7 seconds" in (step_dir / "stderr.txt").read_text(encoding="utf-8")


def test_interactive_stage_json_contract_validation() -> None:
    with pytest.raises(ValueError, match="non-JSON"):
        cli._parse_interactive_stage_json("not json")

    with pytest.raises(ValueError, match="requires at least one question"):
        cli._parse_interactive_stage_json(
            json.dumps(
                {
                    "status": "needs_input",
                    "questions": [],
                    "changed_files": [],
                    "blocker": "",
                }
            )
        )

    result = cli._parse_interactive_stage_json(
        json.dumps(
            {
                "status": "needs_input",
                "questions": [
                    {"question": "q1", "recommended": "r1"},
                    {"question": "q2", "recommended": "r2"},
                    {"question": "q3", "recommended": "r3"},
                    {"question": "q4", "recommended": "r4"},
                ],
                "changed_files": [],
                "blocker": "",
            }
        )
    )
    assert [item["question"] for item in result["questions"]] == ["q1", "q2", "q3"]


def test_interactive_stage_answers_are_utf8_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("builtins.input", lambda _prompt: "fleeting note \udcff")

    answers = cli._read_interactive_stage_answers(
        cli.procedure_stage("requirements-definition"),
        [{"question": "Question \udcff", "recommended": "Recommended \udcff"}],
    )

    dumped = json.dumps(answers, ensure_ascii=False)
    assert "\udcff" not in dumped
    dumped.encode("utf-8")


def test_save_interactive_stage_session_accepts_lone_surrogates(tmp_path: Path) -> None:
    cli._save_interactive_stage_session(
        tmp_path,
        {"answers": [{"question": "Question", "recommended": "", "answer": "Graph note \udcff"}]},
    )

    text = (tmp_path / "grill-me-session.json").read_text(encoding="utf-8")
    assert "\udcff" not in text
    assert "Graph note ?" in text


def test_interactive_content_review_json_contract_validation() -> None:
    with pytest.raises(ValueError, match="non-JSON"):
        cli._parse_interactive_review_json("not json")

    with pytest.raises(ValueError, match="requires at least one question"):
        cli._parse_interactive_review_json(
            json.dumps(
                {
                    "status": "needs_input",
                    "questions": [],
                    "review_file": "review.md",
                    "findings": [],
                    "blocker": "",
                }
            )
        )

    result = cli._parse_interactive_review_json(
        json.dumps(
            {
                "status": "needs_input",
                "questions": [
                    {"question": "q1", "recommended": "r1"},
                    {"question": "q2", "recommended": "r2"},
                    {"question": "q3", "recommended": "r3"},
                    {"question": "q4", "recommended": "r4"},
                ],
                "review_file": "review.md",
                "findings": ["f1"],
                "blocker": "",
            }
        )
    )
    assert [item["question"] for item in result["questions"]] == ["q1", "q2", "q3"]
    assert result["findings"] == ["f1"]


def test_help_command_outputs_curated_runtime_commands(tmp_path: Path, capsys) -> None:
    exit_code = main(["--repo-root", str(tmp_path), "help"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Harness runtime commands" in output
    assert "update" in output
    assert "reset" in output
    assert "Shell completion target" not in output


def test_help_command_outputs_command_topic(tmp_path: Path, capsys) -> None:
    exit_code = main(["--repo-root", str(tmp_path), "help", "update"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Usage: harness update [--repo URL] [--ref REF] [--skip-venv] [--dry-run]" in output
    assert "--shell" not in output


def test_procedure_stage_apply_records_changeset_status(tmp_path: Path, capsys) -> None:
    write_changeset(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "implementation",
            "CHG-001",
            "--uc",
            "UC-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Stage: implementation" in output
    assert "ChangeSet status: blocked" in output
    change_set_text = (tmp_path / "docs/changes/active/CHG-001.md").read_text(
        encoding="utf-8"
    )
    assert "implementation" in change_set_text


def test_report_command_reads_report_markdown(tmp_path: Path, capsys) -> None:
    report_dir = tmp_path / ".harness/runs/run-001"
    report_dir.mkdir(parents=True)
    (report_dir / "report.md").write_text("# Run Report\n", encoding="utf-8")

    exit_code = main(["--repo-root", str(tmp_path), "report", "run-001"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "# Run Report" in output
