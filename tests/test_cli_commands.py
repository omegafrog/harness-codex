import json
from pathlib import Path

import harness_codex.cli as cli_module
from harness_codex.cli import main
from harness_codex.runtime.models import StepResult, StepStatus
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


def test_harvest_plan_outputs_runtime_harvester_stage(
    tmp_path: Path,
    capsys,
) -> None:
    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "harvest",
            "--idea",
            "simple calculator app",
            "--plan",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Workflow: harness-harvest-workflow" in output
    assert "Agent context bootstrap:" in output
    assert "docs/agent/context.md" in output
    assert "Step: harvest-requirements" in output
    assert "Step: harvest-use-cases" in output
    assert "docs/design/요구사항.md" in output
    assert "docs/design/유스케이스.md" in output
    assert not (tmp_path / ".harness/runs").exists()
    assert not (tmp_path / "AGENTS.md").exists()


def test_harvest_interactive_passes_session_options(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    captured = {}

    def fake_run_interactive_harvest(repo_root, idea, *, session_id=None, resume=False):
        captured["repo_root"] = repo_root
        captured["idea"] = idea
        captured["session_id"] = session_id
        captured["resume"] = resume
        return "interactive harvest ok"

    monkeypatch.setattr(
        "harness_codex.cli.run_interactive_harvest",
        fake_run_interactive_harvest,
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "harvest",
            "--interactive",
            "--session-id",
            "harvest-001",
            "--resume",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "interactive harvest ok" in output
    assert captured == {
        "repo_root": tmp_path,
        "idea": "",
        "session_id": "harvest-001",
        "resume": True,
    }


def test_harvest_sessions_command_outputs_runtime_sessions(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "harness_codex.cli.list_harvest_sessions",
        lambda repo_root: f"sessions for {repo_root}",
    )

    exit_code = main(["--repo-root", str(tmp_path), "harvest", "sessions"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert f"sessions for {tmp_path}" in output


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


def test_harvest_apply_warns_and_uses_interactive_runtime(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "harness_codex.runtime.harvest_ui._run_grill_me",
        lambda _root, session: {
            "complete": True,
            "questions": [],
            "requirements_markdown": "\n".join(
                [
                    "# Requirements Specification",
                    "",
                    "## 1. Overview",
                    f"- Initial idea: {session['initial_prompt']}",
                    "",
                    "## Grill-Me Clarifications",
                    "",
                    "| ID | Question | Response |",
                    "| --- | --- | --- |",
                ]
            ),
            "context_markdown": "\n".join(
                [
                    "# Project Context",
                    "",
                    "## 1. Ubiquitous Language",
                    "",
                    "| Canonical Term | Korean | English | Type | Definition | Aliases | Forbidden Terms | Source |",
                    "|---|---|---|---|---|---|---|---|",
                    "| User | 사용자 | User | Actor | Primary actor. | - | - | grill-me |",
                    "",
                    "## 2. Naming Rules",
                    "",
                    "- Documents must use `Canonical Term`.",
                    "",
                    "## 3. Open Language Questions",
                    "",
                    "- None.",
                ]
            ),
        },
    )

    exit_code = main(["--repo-root", str(tmp_path), "harvest", "--idea", "simple calculator app"])

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "harvest requires one of --plan or --interactive" in captured.err


def test_changes_create_from_design_blocks_planning_before_decision_gates(
    tmp_path: Path,
    capsys,
) -> None:
    write_design_docs(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "create-from-design",
            "--title",
            "simple calculator app",
            "--change-set-id",
            "CHG-20260507-001",
            "--related-issue",
            "#77",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "CREATED: CHG-20260507-001" in output
    assert "UC-001: User performs calculator operations" in output
    assert "Agent context:" in output
    assert (tmp_path / "docs/changes/active/CHG-20260507-001.md").is_file()
    assert (tmp_path / "docs/use-cases/UC-001/use-case.md").is_file()
    assert (tmp_path / "docs/use-cases/UC-001/event-storming.md").is_file()
    assert (tmp_path / "docs/use-cases/UC-001/e2e-goal.md").is_file()
    assert (tmp_path / "docs/use-cases/UC-001/affected-files.md").is_file()
    e2e_text = (tmp_path / "docs/use-cases/UC-001/e2e-goal.md").read_text(
        encoding="utf-8"
    )
    assert e2e_text.startswith("---\n")
    assert "doc_type: e2e_goal\n" in e2e_text
    assert "approval_status: approved\n" in e2e_text
    assert "## 4. Business Success Criteria" in e2e_text
    assert "## 5. Business Failure Criteria" in e2e_text
    assert "## 6. Observability Boundary" in e2e_text
    assert "Verification Command" not in e2e_text
    assert "Repository test gate" not in e2e_text
    sidecar = (
        tmp_path
        / ".harness/contracts/CHG-20260507-001/UC-001/e2e_goal.contract.json"
    )
    contract = json.loads(sidecar.read_text(encoding="utf-8"))
    assert contract["path"] == "docs/use-cases/UC-001/e2e-goal.md"
    assert contract["approval_status"] == "approved"
    assert (tmp_path / "AGENTS.md").is_file()
    assert (tmp_path / "docs/agent/context.md").is_file()

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "run-use-case",
            "CHG-20260507-001",
            "UC-001",
            "--preview",
        ]
    )

    preview = capsys.readouterr().out
    assert exit_code == 0
    assert "BLOCKED:" in preview
    assert "UC-001" in preview
    assert "docs/use-cases/UC-001/ddd-design.md" in preview
    assert "docs/use-cases/UC-001/technical-decisions.md" in preview


def test_changes_create_from_design_prompts_for_title_and_change_set_id(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_design_docs(tmp_path)
    answers = iter(["interactive title", "CHG-20260507-009"])
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(answers))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "create-from-design",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "CREATED: CHG-20260507-009" in output
    assert (tmp_path / "docs/changes/active/CHG-20260507-009.md").is_file()


def test_changes_create_from_design_accepts_suggested_change_set_id(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_design_docs(tmp_path)
    active_dir = tmp_path / "docs/changes/active"
    active_dir.mkdir(parents=True, exist_ok=True)
    (active_dir / "CHG-20260507-001.md").write_text("# existing\n", encoding="utf-8")
    answers = iter(["interactive title", ""])
    monkeypatch.setattr("builtins.input", lambda _prompt="": next(answers))
    monkeypatch.setattr("harness_codex.cli.datetime", FakeDateTime)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "create-from-design",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "CREATED: CHG-20260507-002" in output
    assert (tmp_path / "docs/changes/active/CHG-20260507-002.md").is_file()


def test_changes_create_from_design_reports_missing_design_doc(
    tmp_path: Path,
    capsys,
) -> None:
    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "changes",
            "create-from-design",
            "--title",
            "simple calculator app",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "Required design document not found" in captured.err
    assert not (tmp_path / "AGENTS.md").exists()
    assert not (tmp_path / "docs/agent").exists()


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

    monkeypatch.setattr(
        cli_module,
        "procedure_stage_command",
        fake_procedure_stage_command,
    )
    monkeypatch.setattr(cli_module, "run_change_command", fake_run_change_command)

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

    monkeypatch.setattr(
        cli_module,
        "procedure_stage_command",
        fake_procedure_stage_command,
    )
    monkeypatch.setattr(cli_module, "run_change_command", fake_run_change_command)

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
    plan.parent.mkdir(parents=True)
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


class FakeDateTime:
    @classmethod
    def now(cls):
        class _Now:
            def strftime(self, fmt: str) -> str:
                return "20260507"

        return _Now()


class FakeSuccessfulRunner:
    def run(self, step, context):
        return StepResult(step_id=step.id, status=StepStatus.SUCCEEDED)


def test_requirements_definition_creates_temporary_changeset_without_id(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    monkeypatch.setattr("harness_codex.cli.BasicStepRunner", FakeSuccessfulRunner)
    monkeypatch.setattr("harness_codex.cli.verify_procedure_stage", lambda *_, **__: (True, ()))
    monkeypatch.setattr("harness_codex.cli.datetime", FakeDateTime)

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
    monkeypatch.setattr("harness_codex.cli.BasicStepRunner", FakeSuccessfulRunner)
    monkeypatch.setattr("harness_codex.cli.verify_procedure_stage", lambda *_, **__: (True, ()))
    monkeypatch.setattr("harness_codex.cli.datetime", FakeDateTime)

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
    assert "|ChangeSet ID|`CHG-20260507-001`|" in final_text
    assert "|use-case-definition|Use Case Definition|verified|" in final_text


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


def test_run_change_apply_completes_when_work_item_plan_already_completed(
    tmp_path: Path,
    capsys,
) -> None:
    write_changeset(tmp_path)
    completed_plan = tmp_path / "docs/plans/completed/UC-001/plan.md"
    completed_plan.parent.mkdir(parents=True)
    completed_plan.write_text("# Completed Plan\n", encoding="utf-8")

    exit_code = main(
        ["--repo-root", str(tmp_path), "run-change", "CHG-001", "--apply"]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "APPLY completed" in output
    assert not (tmp_path / "docs/changes/active/CHG-001.md").exists()
    assert (tmp_path / "docs/changes/completed/CHG-001.md").is_file()
    run_dir = next((tmp_path / ".harness/runs").iterdir())
    assert (run_dir / "changeset-completion-report.md").is_file()


def test_resume_reports_environment_blocker(tmp_path: Path, capsys) -> None:
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
    assert '\"id\": \"MAINT-001\"' in output
    assert '\"type\": \"maintenance\"' in output
