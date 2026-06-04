import json
from pathlib import Path

import pytest

import harness_codex.cli as cli
from harness_codex.cli import main
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


def test_requirements_definition_creates_temporary_changeset_without_id(
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
    assert "|ChangeSet ID|`CHG-20260507-001`|" in final_text
    assert "|use-case-definition|Use Case Definition|verified|" in final_text


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
    assert len(review_calls) == 4
    assert all("Return only JSON with keys: status, questions, changed_files, blocker" in prompt for prompt in calls)
    assert all("artifact_reviewer" in prompt for prompt in review_calls)


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
