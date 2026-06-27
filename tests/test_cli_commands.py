import hashlib
import json
import re
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

import harness_codex.cli as cli
from harness_codex.cli import main
from harness_codex.runtime import FailureKind, RunMode, RunResult, RunStatus
from harness_codex.runtime.models import StepResult, StepStatus
from harness_codex.runtime.changes.models import (
    AffectedUseCase,
    ChangeSet,
    PlanningInputScope,
)
from harness_codex.runtime.preflight import preflight_cache_key, run_workflow_preflight
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


def add_affected_use_case(repo: Path, uc_id: str) -> None:
    change_set_path = repo / "docs/changes/active/CHG-001.md"
    text = change_set_path.read_text(encoding="utf-8")
    text = text.replace(
        "|`UC-001`|결제 승인|update|`docs/use-cases/UC-001/`|planned|\n",
        "|`UC-001`|결제 승인|update|`docs/use-cases/UC-001/`|planned|\n"
        f"|`{uc_id}`|알림 삭제|update|`docs/use-cases/{uc_id}/`|planned|\n",
    )
    change_set_path.write_text(text, encoding="utf-8")
    write_use_case_slice(repo, uc_id)


def write_design_visualization_artifacts(repo: Path, uc_id: str) -> None:
    slice_dir = repo / "docs/use-cases" / uc_id
    (repo / "docs/design").mkdir(parents=True, exist_ok=True)
    (repo / "docs/design/ubiquitous-language.md").write_text("# Language\n", encoding="utf-8")
    (repo / "ARCHITECTURE.md").write_text("# Architecture\n", encoding="utf-8")
    (slice_dir / "class-diagram.md").write_text(
        "# Class Diagram\n\n```mermaid\nclassDiagram\n    class Notification\n```\n",
        encoding="utf-8",
    )
    (slice_dir / "flow-diagram.md").write_text(
        "# Flow Diagram\n\n```mermaid\nflowchart TD\n    A --> B\n```\n",
        encoding="utf-8",
    )
    source_paths = (
        slice_dir / "use-case.md",
        slice_dir / "e2e-goal.md",
        slice_dir / "event-storming.md",
        slice_dir / "ddd-design.md",
        slice_dir / "technical-decisions.md",
        repo / "docs/design/ubiquitous-language.md",
        repo / "ARCHITECTURE.md",
    )
    metadata = {
        "change_set_id": "CHG-001",
        "uc_id": uc_id,
        "status": "verified",
        "source_documents": {
            str(path.relative_to(repo)): f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"
            for path in source_paths
        },
    }
    (slice_dir / "diagram-metadata.json").write_text(
        json.dumps(metadata, indent=2),
        encoding="utf-8",
    )


def add_procedure_state_table(repo: Path) -> None:
    change_set_path = repo / "docs/changes/active/CHG-001.md"
    table = render_initial_changeset(
        change_set_id="CHG-001",
        title="ChangeSet CHG-001",
        request_summary="test",
    ).split("## 3. Runtime Procedure State", 1)[1].split("## 4.", 1)[0]
    change_set_path.write_text(
        change_set_path.read_text(encoding="utf-8")
        + "\n\n## 3. Runtime Procedure State"
        + table,
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


def _init_git_repo(repo: Path) -> None:
    subprocess.run(("git", "init"), cwd=repo, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(
        ("git", "config", "user.email", "test@example.com"),
        cwd=repo,
        check=True,
    )
    subprocess.run(
        ("git", "config", "user.name", "Test User"),
        cwd=repo,
        check=True,
    )
    (repo / "README.md").write_text("# Test\n", encoding="utf-8")
    subprocess.run(("git", "add", "README.md"), cwd=repo, check=True)
    subprocess.run(
        ("git", "commit", "-m", "init"),
        cwd=repo,
        check=True,
        stdout=subprocess.DEVNULL,
    )


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


@pytest.mark.parametrize(
    ("stage_id", "stage_args"),
    (
        ("requirements-definition", []),
        ("ubiquitous-language-definition", []),
        ("use-case-definition", []),
        ("event-storming", ["--uc", "UC-001"]),
        ("ddd-architecture-definition", ["--uc", "UC-001"]),
        ("technical-decisions", ["--uc", "UC-001"]),
    ),
)
def test_design_stage_commands_default_to_apply(
    stage_id: str,
    stage_args: list[str],
) -> None:
    args = cli.build_parser().parse_args([stage_id, "CHG-001", *stage_args])

    assert args.plan is False
    assert args.preview is False
    assert args.apply is True


def test_ddd_architecture_command_supports_run_all(
    tmp_path: Path,
    monkeypatch,
) -> None:
    change_path = tmp_path / "docs/changes/active/CHG-001.md"
    change_path.parent.mkdir(parents=True)
    change_path.write_text("# CHG-001\n", encoding="utf-8")

    monkeypatch.setattr(
        cli,
        "run_all_ddd_architecture_changeset",
        lambda repo_root, change_set_id: {
            "change_set_id": change_set_id,
            "harvest": {
                "ddd_architecture": {
                    "completed_count": 10,
                    "total_count": 10,
                    "status": "complete",
                    "complete": True,
                    "current_uc": None,
                    "current_step": None,
                },
                "current_question": None,
                "runtime_error": "",
            },
        },
    )

    args = cli.build_parser().parse_args(
        ["ddd-architecture-definition", "CHG-001", "--all"]
    )
    output = cli.procedure_stage_command(args, tmp_path)

    assert "Mode: run-all" in output
    assert "Completed: 10 / 10" in output
    assert "Status: complete" in output


def test_ddd_architecture_run_all_rejects_uc() -> None:
    args = cli.build_parser().parse_args(
        ["ddd-architecture-definition", "CHG-001", "--all", "--uc", "UC-001"]
    )

    with pytest.raises(ValueError, match="cannot be combined"):
        cli.procedure_stage_command(args, Path("."))


def test_ddd_architecture_command_supports_rerun_step(
    tmp_path: Path,
    monkeypatch,
) -> None:
    change_path = tmp_path / "docs/changes/active/CHG-001.md"
    change_path.parent.mkdir(parents=True)
    change_path.write_text("# CHG-001\n", encoding="utf-8")
    captured: dict[str, str] = {}

    def fake_rerun(
        repo_root: Path,
        change_set_id: str,
        uc_id: str,
        step_id: str,
        user_prompt: str,
    ) -> dict:
        captured.update(
            {
                "root": str(repo_root),
                "change_set_id": change_set_id,
                "uc_id": uc_id,
                "step_id": step_id,
                "prompt": user_prompt,
            }
        )
        return {
            "change_set_id": change_set_id,
            "harvest": {
                "ddd_architecture": {
                    "completed_count": 10,
                    "total_count": 10,
                    "status": "complete",
                    "items": {
                        uc_id: {
                            "steps": {
                                step_id: {
                                    "status": "complete",
                                    "current_question": None,
                                    "error": "",
                                }
                            }
                        }
                    },
                },
                "runtime_error": "",
            },
        }

    monkeypatch.setattr(cli, "rerun_ddd_architecture_step_changeset", fake_rerun)

    args = cli.build_parser().parse_args(
        [
            "ddd-architecture-definition",
            "CHG-001",
            "--uc",
            "UC-001",
            "--rerun-step",
            "application_flow",
            "--prompt",
            "서비스 시그니처를 다시 맞춘다.",
        ]
    )
    output = cli.procedure_stage_command(args, tmp_path)

    assert captured == {
        "root": str(tmp_path),
        "change_set_id": "CHG-001",
        "uc_id": "UC-001",
        "step_id": "application_flow",
        "prompt": "서비스 시그니처를 다시 맞춘다.",
    }
    assert "Mode: rerun-step" in output
    assert "UC: UC-001" in output
    assert "Substep: application_flow" in output
    assert "Status: complete" in output


def test_ddd_architecture_rerun_step_requires_uc() -> None:
    args = cli.build_parser().parse_args(
        ["ddd-architecture-definition", "CHG-001", "--rerun-step", "entity_vo"]
    )

    with pytest.raises(ValueError, match="requires --uc"):
        cli.procedure_stage_command(args, Path("."))


def test_ddd_architecture_rerun_step_rejects_run_all() -> None:
    args = cli.build_parser().parse_args(
        [
            "ddd-architecture-definition",
            "CHG-001",
            "--all",
            "--rerun-step",
            "entity_vo",
        ]
    )

    with pytest.raises(ValueError, match="cannot be combined"):
        cli.procedure_stage_command(args, Path("."))


def test_procedure_stage_notes_prioritize_agent_error(
    tmp_path: Path,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    design_dir = tmp_path / "docs/design"
    design_dir.mkdir(parents=True, exist_ok=True)
    (design_dir / "ubiquitous-language.md").write_text("# 용어\n", encoding="utf-8")

    class BlockedRunner:
        def run(self, step, context):
            return StepResult(
                step_id=step.id,
                status=StepStatus.BLOCKED,
                exit_code=1,
                error="provider quota exceeded",
            )

    monkeypatch.setattr(cli, "BasicStepRunner", BlockedRunner)
    monkeypatch.setattr(
        cli,
        "verify_procedure_stage",
        lambda *_, **__: (
            False,
            (
                "missing output: docs/changes/active/CHG-001.ddd-integration.md",
            ),
        ),
    )

    args = cli.build_parser().parse_args(
        ["ddd-design-integration", "CHG-001", "--force", "--apply"]
    )

    output = cli.procedure_stage_command(args, tmp_path)

    assert "Agent status: blocked" in output
    assert "Notes: provider quota exceeded; missing output:" in output


@pytest.mark.parametrize("mode", ("--plan", "--preview", "--apply"))
def test_design_stage_commands_reject_mode_flags(mode: str) -> None:
    with pytest.raises(SystemExit) as exc:
        cli.build_parser().parse_args(
            ["event-storming", "CHG-001", "--uc", "UC-001", mode]
        )

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
    assert "docs/agent/codebase-artifacts.md: created" in output
    assert "docs/agent/design-conformance-report.md: created" in output
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


def test_ultrawork_request_creates_design_docs_and_changeset(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        cli,
        "procedure_stage_command",
        lambda args, _repo_root: "\n".join(
            [
                f"Stage: {args.procedure_stage_id}",
                "Verification: passed",
                "ChangeSet status: verified",
            ]
        ),
    )
    monkeypatch.setattr(
        cli,
        "run_change_command",
        lambda args, _repo_root: f"Mode: preview\nChangeSet: {args.change_set_id}",
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "ultrawork",
            "--title",
            "Python CLI calculator with undo",
            "--request",
            "Create a Python 3 CLI calculator with four operations and one-step undo.",
            "--change-set-id",
            "CHG-20260507-010",
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "CREATED: CHG-20260507-010" in output
    assert (tmp_path / "docs/design/요구사항.md").is_file()
    assert (tmp_path / "docs/design/유스케이스.md").is_file()
    assert (tmp_path / "docs/changes/active/CHG-20260507-010.md").is_file()
    assert (tmp_path / "docs/use-cases/UC-001/use-case.md").is_file()
    show_args = SimpleNamespace(change_set_id="CHG-20260507-010", raw=False)
    assert "Affected UC: UC-001" in cli.changes_show_command(show_args, tmp_path)


def test_ultrawork_request_refuses_to_overwrite_design_docs_without_force(
    tmp_path: Path,
    capsys,
) -> None:
    write_design_docs(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "ultrawork",
            "--request",
            "Create something else.",
            "--change-set-id",
            "CHG-20260507-011",
            "--preview",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert "Design docs already exist; pass --force" in captured.err


def test_ultrawork_request_force_regenerates_design_docs(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_design_docs(tmp_path)
    monkeypatch.setattr(
        cli,
        "procedure_stage_command",
        lambda _args, _repo_root: "Stage: event-storming\nVerification: passed",
    )
    monkeypatch.setattr(
        cli,
        "run_change_command",
        lambda args, _repo_root: f"Mode: preview\nChangeSet: {args.change_set_id}",
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "ultrawork",
            "--request",
            "Create a command line timer.",
            "--change-set-id",
            "CHG-20260507-012",
            "--force",
            "--preview",
        ]
    )

    assert exit_code == 0
    capsys.readouterr()
    requirements = (tmp_path / "docs/design/요구사항.md").read_text(encoding="utf-8")
    assert "Create a command line timer." in requirements


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


def test_implementation_selects_changeset_and_lists_uc_scoped_plans(
    tmp_path: Path,
    capsys,
) -> None:
    write_changeset(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "implementation",
            "CHG-001",
            "--plan",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "ChangeSet: CHG-001" in output
    assert "Work item: UC-001" in output
    assert "Type: use_case" in output
    assert "docs/plans/active/UC-001/plan.md" in output
    assert "docs/plans/active/plan.md" not in output


def test_implementation_rejects_manual_uc_selection(
    tmp_path: Path,
    capsys,
) -> None:
    write_changeset(tmp_path)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "implementation",
            "CHG-001",
            "--uc",
            "UC-001",
            "--plan",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 2
    assert (
        "implementation selects a ChangeSet and executes each affected UC"
        in captured.err
    )


def test_implementation_apply_blocks_placeholder_affected_files_before_runner(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    affected = tmp_path / "docs/use-cases/UC-001/affected-files.md"
    affected.write_text(
        "# UC-001 Affected Files\n\n"
        "## Expected Changed Files\n\n"
        "- Application source paths\n",
        encoding="utf-8",
    )

    def fail_if_runner_starts(*_args, **_kwargs):
        raise AssertionError("RunnerEngine must not start when preflight blocks")

    monkeypatch.setattr(cli.RunnerEngine, "run", fail_if_runner_starts)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "implementation",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "BLOCKED: deterministic preflight failed for CHG-001" in output
    assert "Failed check: affected-files-no-placeholders" in output
    assert "Application source paths" in output
    assert "Resume command: harness implementation CHG-001 --apply" in output
    preflight_files = list((tmp_path / ".harness/runs").glob("*/preflight.json"))
    assert len(preflight_files) == 1
    preflight = json.loads(preflight_files[0].read_text(encoding="utf-8"))
    assert preflight["status"] == "blocked"
    assert preflight["checks"][0]["check_id"] == "affected-files-no-placeholders"


def test_workflow_preflight_reports_missing_required_tool(
    tmp_path: Path,
    monkeypatch,
) -> None:
    settings = tmp_path / ".codex"
    settings.mkdir()
    (settings / "repository-settings.md").write_text(
        "# Repository Settings\n\n- Runtime verification: docker compose up\n",
        encoding="utf-8",
    )
    monkeypatch.setattr("harness_codex.runtime.preflight.shutil.which", lambda _binary: None)

    result = run_workflow_preflight(tmp_path, "CHG-001", ())

    assert result.status == "blocked"
    blocking = result.blocking_checks
    assert blocking[0].check_id == "required-tool-docker"
    assert blocking[0].override_allowed is True
    assert "docker not found on PATH" in blocking[0].evidence


def test_preflight_cache_key_is_stable_for_head_and_command(tmp_path: Path) -> None:
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")

    first = preflight_cache_key(tmp_path, "./gradlew test")
    second = preflight_cache_key(tmp_path, "./gradlew test")
    third = preflight_cache_key(tmp_path, "./gradlew build")

    assert first == second
    assert first != third


def test_workflow_preflight_caches_failed_baseline_command(
    tmp_path: Path,
) -> None:
    _init_git_repo(tmp_path)
    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    command = (
        "python3 -c \"from pathlib import Path; "
        "Path('marker.txt').write_text(Path('marker.txt').read_text() + 'x' "
        "if Path('marker.txt').exists() else 'x'); raise SystemExit(7)\""
    )
    (codex_dir / "test-gate.yaml").write_text(
        f"baseline:\n  - command: {json.dumps(command)}\n",
        encoding="utf-8",
    )

    first = run_workflow_preflight(tmp_path, "CHG-001", ())
    second = run_workflow_preflight(tmp_path, "CHG-001", ())

    assert first.status == "blocked"
    assert second.status == "blocked"
    assert (tmp_path / "marker.txt").read_text(encoding="utf-8") == "x"
    assert any("baseline failure" in item for item in first.blocking_checks[0].evidence)
    assert any("cached baseline command result" in item for item in second.blocking_checks[0].evidence)
    assert list((tmp_path / ".harness/preflight-cache").glob("*.json"))


def test_workflow_preflight_passes_successful_baseline_command(tmp_path: Path) -> None:
    _init_git_repo(tmp_path)
    codex_dir = tmp_path / ".codex"
    codex_dir.mkdir()
    (codex_dir / "test-gate.yaml").write_text(
        "required:\n  - command: python3 -c \"raise SystemExit(0)\"\n",
        encoding="utf-8",
    )

    result = run_workflow_preflight(tmp_path, "CHG-001", ())

    assert result.status == "passed"
    assert any(
        check.check_id.startswith("baseline-command:")
        and check.status == "pass"
        for check in result.checks
    )


def test_plan_writing_uses_no_mode_flags() -> None:
    args = cli.build_parser().parse_args(
        [
            "plan-writing",
            "CHG-001",
            "--uc",
            "UC-001",
        ]
    )

    assert args.procedure_stage_id == "plan-writing"
    assert not args.plan
    assert not args.preview
    assert args.apply
    assert cli._selected_mode(args) == RunMode.APPLY

    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(
            [
                "plan-writing",
                "CHG-001",
                "--uc",
                "UC-001",
                "--preview",
            ]
        )


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


def test_changes_continue_reruns_verified_implementation_with_active_plan(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    write_design_visualization_artifacts(tmp_path, "UC-001")
    add_procedure_state_table(tmp_path)
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    text = change_set_path.read_text(encoding="utf-8")
    for stage in cli.PROCEDURE_STAGES:
        text = cli.update_changeset_stage_status(
            text,
            stage=stage,
            status="verified",
            notes="complete",
        )
    change_set_path.write_text(text, encoding="utf-8")
    active_plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    active_plan.parent.mkdir(parents=True, exist_ok=True)
    active_plan.write_text("# Plan\n\n- [ ] Remaining task\n", encoding="utf-8")
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
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Target stage: implementation" in output
    assert "verified state is stale" in output
    assert captured == {
        "stage": "implementation",
        "uc": "",
        "force": True,
    }


def test_changes_continue_reruns_stale_verified_upstream_before_blocked_plan(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    add_affected_use_case(tmp_path, "UC-002")
    add_procedure_state_table(tmp_path)
    (tmp_path / "docs/use-cases/UC-002/technical-decisions.md").unlink()
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    text = change_set_path.read_text(encoding="utf-8")
    for stage in cli.PROCEDURE_STAGES:
        text = cli.update_changeset_stage_status(
            text,
            stage=stage,
            status="verified",
            notes="complete",
        )
    text = cli.update_changeset_stage_status(
        text,
        stage=cli.procedure_stage("plan-writing"),
        status="blocked",
        notes="missing inputs for UC-002",
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
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Target stage: technical-decisions" in output
    assert "verified state is stale" in output
    assert "docs/use-cases/UC-002/technical-decisions.md" in output
    assert captured == {
        "stage": "technical-decisions",
        "uc": "UC-002",
        "force": True,
    }


def test_changes_continue_uses_integration_candidates_when_changeset_has_no_affected_table(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    change_dir = tmp_path / "docs/changes/active"
    change_dir.mkdir(parents=True)
    change_path = change_dir / "CHG-001.md"
    change_path.write_text(
        render_initial_changeset(
            change_set_id="CHG-001",
            title="Notification",
            request_summary="Notification workflow",
        ),
        encoding="utf-8",
    )
    (change_dir / "CHG-001.ddd-integration.json").write_text(
        json.dumps(
            {
                "candidate_inputs": [
                    {"uc_id": "UC-001", "path": "docs/use-cases/UC-001/ddd-design.md"},
                    {"uc_id": "UC-002", "path": "docs/use-cases/UC-002/ddd-design.md"},
                ]
            }
        ),
        encoding="utf-8",
    )
    write_use_case_slice(tmp_path, "UC-001")
    write_use_case_slice(tmp_path, "UC-002")
    (tmp_path / "docs/use-cases/UC-002/technical-decisions.md").unlink()
    text = change_path.read_text(encoding="utf-8")
    for stage in cli.PROCEDURE_STAGES:
        text = cli.update_changeset_stage_status(
            text,
            stage=stage,
            status="verified",
            notes="complete",
        )
    text = cli.update_changeset_stage_status(
        text,
        stage=cli.procedure_stage("plan-writing"),
        status="blocked",
        notes="missing inputs for UC-002",
    )
    change_path.write_text(text, encoding="utf-8")
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
            "--preview",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Target stage: technical-decisions" in output
    assert "UC: UC-002" in output
    assert captured == {
        "stage": "technical-decisions",
        "uc": "UC-002",
        "force": True,
    }


def test_direct_uc_scoped_stage_verifies_only_selected_use_case(
    tmp_path: Path,
) -> None:
    change_dir = tmp_path / "docs/changes/active"
    change_dir.mkdir(parents=True)
    change_path = change_dir / "CHG-001.md"
    change_path.write_text(
        render_initial_changeset(
            change_set_id="CHG-001",
            title="Notification",
            request_summary="Notification workflow",
        ),
        encoding="utf-8",
    )
    (change_dir / "CHG-001.ddd-integration.json").write_text(
        json.dumps(
            {
                "candidate_inputs": [
                    {"uc_id": "UC-030", "path": "docs/use-cases/UC-030/ddd-design.md"},
                    {"uc_id": "UC-031", "path": "docs/use-cases/UC-031/ddd-design.md"},
                    {"uc_id": "UC-032", "path": "docs/use-cases/UC-032/ddd-design.md"},
                ]
            }
        ),
        encoding="utf-8",
    )
    for uc_id in ("UC-030", "UC-031", "UC-032"):
        write_use_case_slice(tmp_path, uc_id)
        (tmp_path / f"docs/use-cases/{uc_id}/technical-decisions.md").unlink()
    (tmp_path / "docs/use-cases/UC-031/technical-decisions.md").write_text(
        "# UC-031 Technical Decisions\n\nApproved.\n",
        encoding="utf-8",
    )

    selected_passed, selected_problems = cli.verify_procedure_stage(
        tmp_path,
        cli.procedure_stage("technical-decisions"),
        change_set_id="CHG-001",
        uc_id="UC-031",
    )
    aggregate_passed, aggregate_problems = cli._verify_procedure_stage_for_changeset(
        tmp_path,
        cli.procedure_stage("technical-decisions"),
        change_set_id="CHG-001",
        uc_id="UC-031",
    )

    assert selected_passed is True
    assert selected_problems == ()
    assert aggregate_passed is False
    assert "docs/use-cases/UC-030/technical-decisions.md" in "; ".join(aggregate_problems)
    assert "docs/use-cases/UC-032/technical-decisions.md" in "; ".join(aggregate_problems)


def test_all_technical_decisions_runs_each_affected_use_case(
    tmp_path: Path,
    monkeypatch,
) -> None:
    change_dir = tmp_path / "docs/changes/active"
    change_dir.mkdir(parents=True)
    (change_dir / "CHG-001.md").write_text(
        render_initial_changeset(
            change_set_id="CHG-001",
            title="Notification",
            request_summary="Notification workflow",
        ),
        encoding="utf-8",
    )
    (change_dir / "CHG-001.ddd-integration.json").write_text(
        json.dumps(
            {
                "candidate_inputs": [
                    {"uc_id": "UC-030", "path": "docs/use-cases/UC-030/ddd-design.md"},
                    {"uc_id": "UC-031", "path": "docs/use-cases/UC-031/ddd-design.md"},
                    {"uc_id": "UC-032", "path": "docs/use-cases/UC-032/ddd-design.md"},
                ]
            }
        ),
        encoding="utf-8",
    )
    for uc_id in ("UC-030", "UC-031", "UC-032"):
        write_use_case_slice(tmp_path, uc_id)
        (tmp_path / f"docs/use-cases/{uc_id}/technical-decisions.md").unlink()
    (tmp_path / "docs/use-cases/UC-031/technical-decisions.md").write_text(
        "# UC-031 Technical Decisions\n",
        encoding="utf-8",
    )
    captured: list[str] = []

    def fake_stage_command(args, _repo_root):
        captured.append(args.uc)
        return "\n".join(
            [
                "Stage: technical-decisions",
                f"UC: {args.uc}",
                "Verification: passed",
                "ChangeSet status: verified",
            ]
        )

    monkeypatch.setattr(cli, "procedure_stage_command", fake_stage_command)

    output = cli._run_all_technical_decisions_stage(
        SimpleNamespace(change_set_id="CHG-001", title="", idea=""),
        tmp_path,
        RunMode.APPLY,
    )

    assert captured == ["UC-030", "UC-031", "UC-032"]
    assert "Mode: run-all" in output
    assert "- UC-030" in output
    assert "- UC-031" in output
    assert "- UC-032" in output


def test_all_technical_decisions_continues_after_blocked_use_case(
    tmp_path: Path,
    monkeypatch,
) -> None:
    change_dir = tmp_path / "docs/changes/active"
    change_dir.mkdir(parents=True)
    (change_dir / "CHG-001.md").write_text(
        render_initial_changeset(
            change_set_id="CHG-001",
            title="Notification",
            request_summary="Notification workflow",
        ),
        encoding="utf-8",
    )
    (change_dir / "CHG-001.ddd-integration.json").write_text(
        json.dumps(
            {
                "candidate_inputs": [
                    {"uc_id": "UC-030", "path": "docs/use-cases/UC-030/ddd-design.md"},
                    {"uc_id": "UC-031", "path": "docs/use-cases/UC-031/ddd-design.md"},
                    {"uc_id": "UC-032", "path": "docs/use-cases/UC-032/ddd-design.md"},
                ]
            }
        ),
        encoding="utf-8",
    )
    for uc_id in ("UC-030", "UC-031", "UC-032"):
        write_use_case_slice(tmp_path, uc_id)
        (tmp_path / f"docs/use-cases/{uc_id}/technical-decisions.md").unlink()
    captured: list[str] = []

    def fake_stage_command(args, _repo_root):
        captured.append(args.uc)
        if args.uc == "UC-030":
            return "\n".join(
                [
                    "Stage: technical-decisions",
                    "UC: UC-030",
                    "Interactive status: needs_input",
                    "ChangeSet status: blocked",
                ]
            )
        return "\n".join(
            [
                "Stage: technical-decisions",
                f"UC: {args.uc}",
                "Verification: passed",
                "ChangeSet status: verified",
            ]
        )

    monkeypatch.setattr(cli, "procedure_stage_command", fake_stage_command)

    output = cli._run_all_technical_decisions_stage(
        SimpleNamespace(change_set_id="CHG-001", title="", idea=""),
        tmp_path,
        RunMode.APPLY,
    )

    assert captured == ["UC-030", "UC-031", "UC-032"]
    assert "Blocked at UC-030; continuing remaining technical-decisions use cases." in output
    assert "Blocked use cases:" in output


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
        ["requirements-definition", "CHG-001"],
        ["ubiquitous-language-definition", "CHG-001"],
        ["use-case-definition", "CHG-001"],
        ["event-storming", "CHG-001", "--uc", "UC-001"],
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
    assert "After writing `docs/design/ubiquitous-language.md`, do not run extra verification tool calls" in calls[1]
    assert "Which canonical term should represent an approved saved link between notes?" in calls[1]


def test_interactive_ddd_stage_boundary_derives_representations_from_slice_evidence() -> None:
    boundary = cli._interactive_stage_boundary("ddd-architecture-definition")

    assert "Ask only when missing or contradictory slice evidence" in boundary
    assert "Do not ask the user to choose representation details already implied" in boundary
    assert "serialization mechanics" in boundary


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


def test_technical_decisions_requests_user_input_before_verification(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    monkeypatch.setenv("HARNESS_NONINTERACTIVE", "1")
    monkeypatch.setattr(
        cli,
        "_exec_stage_grill_me_prompt",
        lambda *_args: json.dumps(
            {
                "status": "needs_input",
                "questions": [
                    {
                        "question": "Which cipher should encrypt stored image bytes at rest: AES-256-GCM or ChaCha20-Poly1305?",
                        "recommended": "Use AES-256-GCM for Java runtime support.",
                    }
                ],
                "changed_files": [
                    "docs/use-cases/UC-001/technical-decisions.md"
                ],
                "blocker": "",
            }
        ),
    )
    monkeypatch.setattr(
        cli,
        "verify_procedure_stage",
        lambda *_, **__: pytest.fail("verification must wait for user input"),
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "technical-decisions",
            "CHG-001",
            "--uc",
            "UC-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: needs_input" in output
    assert "Verification: skipped" in output
    assert "Pending questions:" in output
    assert "Which cipher should encrypt stored image bytes at rest" in output
    assert "Recommended: Use AES-256-GCM for Java runtime support." in output

    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["status"] == "needs_input"
    assert session["pending_questions"] == [
        {
            "question": "Which cipher should encrypt stored image bytes at rest: AES-256-GCM or ChaCha20-Poly1305?",
            "recommended": "Use AES-256-GCM for Java runtime support.",
        }
    ]


def test_technical_decisions_pending_artifact_is_reported_as_user_input(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    monkeypatch.setenv("HARNESS_NONINTERACTIVE", "1")

    def fake_exec(root: Path, *_args) -> str:
        (root / "docs/use-cases/UC-001/technical-decisions.md").write_text(
            """# UC-001. Technical Decisions

## 1. Metadata
|Item|Value|
|---|---|
|Approval Status|pending|

## 7. Pending Decisions
- Encryption cipher is not approved. Exact question: should stored image bytes use AES-256-GCM or ChaCha20-Poly1305?
- Runtime proxy mechanism is not approved. Exact question: should adapter retries use Spring AOP proxies or explicit Resilience4j decorators?
""",
            encoding="utf-8",
        )
        return json.dumps(
            {
                "status": "blocked",
                "questions": [],
                "changed_files": ["docs/use-cases/UC-001/technical-decisions.md"],
                "blocker": "technical decisions remain pending",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_exec)
    monkeypatch.setattr(
        cli,
        "verify_procedure_stage",
        lambda *_, **__: pytest.fail("verification must wait for pending TD answers"),
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "technical-decisions",
            "CHG-001",
            "--uc",
            "UC-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: needs_input" in output
    assert "Verification: skipped" in output
    assert "should stored image bytes use AES-256-GCM" in output
    assert "should adapter retries use Spring AOP proxies" in output

    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["status"] == "needs_input"
    assert session["pending_questions"][0]["question"].startswith(
        "should stored image bytes use AES-256-GCM"
    )


def test_technical_decisions_business_policy_question_is_blocked_not_asked(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    monkeypatch.setenv("HARNESS_NONINTERACTIVE", "1")
    monkeypatch.setattr(
        cli,
        "_exec_stage_grill_me_prompt",
        lambda *_args: json.dumps(
            {
                "status": "needs_input",
                "questions": [
                    {
                        "question": "What server-side draft store and expiry should DraftStateStore use for unsaved image-note drafts?",
                        "recommended": "Use JPA/H2 and expire drafts after 24 hours.",
                    }
                ],
                "changed_files": ["docs/use-cases/UC-001/technical-decisions.md"],
                "blocker": "",
            }
        ),
    )
    monkeypatch.setattr(
        cli,
        "verify_procedure_stage",
        lambda *_, **__: pytest.fail("verification must not run for blocked boundary violation"),
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "technical-decisions",
            "CHG-001",
            "--uc",
            "UC-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: needs_input" in output
    assert "outside the technical decision boundary" in output
    assert "Pending questions:" in output
    assert "How should this blocker be resolved?" in output


def test_technical_decisions_prompt_rejects_hypothetical_lifecycle_blockers(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    prompts: list[str] = []
    monkeypatch.setenv("HARNESS_NONINTERACTIVE", "1")

    def fake_exec(_root: Path, _step_dir: Path, prompt: str, _label: str) -> str:
        prompts.append(prompt)
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": ["docs/use-cases/UC-001/technical-decisions.md"],
                "blocker": "",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_exec)
    monkeypatch.setattr(cli, "_exec_stage_review_prompt", lambda *_args: json.dumps(
        {
            "status": "complete",
            "questions": [],
            "review_file": ".harness/review.md",
            "findings": [],
            "blocker": "",
        }
    ))
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: (True, []))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "technical-decisions",
            "CHG-001",
            "--uc",
            "UC-001",
            "--force",
        ]
    )

    assert exit_code == 0
    assert prompts
    assert "Do not invent abandoned-draft, orphan-asset" in prompts[0]
    assert "Their absence is not an upstream blocker" in prompts[0]
    assert "exact upstream evidence" in prompts[0]
    assert "Interactive status: complete" in capsys.readouterr().out


def test_technical_decisions_pending_business_policy_is_not_converted_to_question(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    monkeypatch.setenv("HARNESS_NONINTERACTIVE", "1")

    def fake_exec(root: Path, *_args) -> str:
        (root / "docs/use-cases/UC-001/technical-decisions.md").write_text(
            """# UC-001. Technical Decisions

## 1. Metadata
|Item|Value|
|---|---|
|Approval Status|pending|

## 7. Pending Decisions
- Draft expiry policy is not approved. Exact question: what server-side draft store and expiry should DraftStateStore use for unsaved image-note drafts?
""",
            encoding="utf-8",
        )
        return json.dumps(
            {
                "status": "blocked",
                "questions": [],
                "changed_files": ["docs/use-cases/UC-001/technical-decisions.md"],
                "blocker": "technical decisions remain pending",
            }
        )

    monkeypatch.setattr(cli, "_exec_stage_grill_me_prompt", fake_exec)
    monkeypatch.setattr(
        cli,
        "verify_procedure_stage",
        lambda *_, **__: pytest.fail("verification must wait for upstream policy"),
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "technical-decisions",
            "CHG-001",
            "--uc",
            "UC-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: needs_input" in output
    assert "Pending questions:" in output
    assert "DraftStateStore use" not in output


def test_technical_decisions_blocker_becomes_interactive_resolution_question(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    monkeypatch.setenv("HARNESS_NONINTERACTIVE", "1")
    monkeypatch.setattr(
        cli,
        "_exec_stage_grill_me_prompt",
        lambda *_args: json.dumps(
            {
                "status": "blocked",
                "questions": [],
                "changed_files": [
                    "docs/use-cases/UC-001/technical-decisions.md"
                ],
                "blocker": (
                    "Upstream DDD Architecture Definition unresolved: "
                    "ddd-design.md has status in_progress."
                ),
            }
        ),
    )
    monkeypatch.setattr(
        cli,
        "verify_procedure_stage",
        lambda *_, **__: pytest.fail("verification must wait for user resolution"),
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "technical-decisions",
            "CHG-001",
            "--uc",
            "UC-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: needs_input" in output
    assert "How should this blocker be resolved?" in output
    assert "Rerun and approve DDD Architecture Definition" in output
    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["status"] == "needs_input"
    assert session["turns"][0]["status"] == "needs_input"
    assert session["pending_questions"][0]["recommended"].startswith(
        "Rerun and approve DDD Architecture Definition"
    )


def test_technical_decisions_blocked_review_becomes_interactive_question(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    monkeypatch.setenv("HARNESS_NONINTERACTIVE", "1")
    monkeypatch.setattr(
        cli,
        "_exec_stage_grill_me_prompt",
        lambda *_args: json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": [
                    "docs/use-cases/UC-001/technical-decisions.md"
                ],
                "blocker": "",
            }
        ),
    )
    monkeypatch.setattr(
        cli,
        "_exec_stage_review_prompt",
        lambda *_args: json.dumps(
            {
                "status": "blocked",
                "questions": [],
                "review_file": (
                    ".harness/runs/run-test/reviews/"
                    "technical-decisions-content-review.md"
                ),
                "findings": ["DDD stage is stale."],
                "blocker": "Upstream DDD design is unresolved.",
            }
        ),
    )
    monkeypatch.setattr(
        cli,
        "verify_procedure_stage",
        lambda *_, **__: pytest.fail("verification must wait for user resolution"),
    )

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "technical-decisions",
            "CHG-001",
            "--uc",
            "UC-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: needs_input" in output
    assert "Content review: needs_input" in output
    assert "How should this blocker be resolved?" in output
    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["status"] == "needs_input"
    assert session["reviews"][0]["status"] == "needs_input"
    assert session["pending_questions"][0]["recommended"].startswith(
        "Rerun and approve DDD Architecture Definition"
    )

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


def test_interactive_content_review_needs_input_stops_without_prompt_in_noninteractive_mode(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)

    monkeypatch.setenv("HARNESS_NONINTERACTIVE", "1")
    monkeypatch.setattr(
        cli,
        "_exec_stage_grill_me_prompt",
        lambda *_args: json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": ["docs/design/요구사항.md"],
                "blocker": "",
            }
        ),
    )
    monkeypatch.setattr(
        cli,
        "_exec_stage_review_prompt",
        lambda *_args: json.dumps(
            {
                "status": "needs_input",
                "questions": [
                    {
                        "question": "Which actor-visible success condition should govern the use case?",
                        "recommended": "Use the saved-note availability condition.",
                    }
                ],
                "review_file": ".harness/runs/run-test/reviews/use-case-definition-content-review.md",
                "findings": ["Success condition needs confirmation."],
                "blocker": "",
            }
        ),
    )
    monkeypatch.setattr("builtins.input", lambda _prompt="": pytest.fail("input must not be called"))
    monkeypatch.setattr(cli, "verify_procedure_stage", lambda *_, **__: pytest.fail("verification must not run"))

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "use-case-definition",
            "CHG-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: needs_input" in output
    assert "Verification: skipped" in output
    assert "Content review: needs_input" in output
    assert "Pending questions:" in output
    assert "Which actor-visible success condition" in output
    assert "content review needs user input" in (
        tmp_path / "docs/changes/active/CHG-001.md"
    ).read_text(encoding="utf-8")
    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["status"] == "needs_input"
    assert session["pending_questions"][0]["recommended"] == (
        "Use the saved-note availability condition."
    )


def test_interactive_stage_seeds_answer_history_from_noninteractive_rerun_answers(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    prompts: list[str] = []
    monkeypatch.setenv(
        "HARNESS_INTERACTIVE_STAGE_ANSWERS",
        json.dumps(
            [
                {
                    "question": "Which success condition was intended?",
                    "recommended": "Use actor-visible save.",
                    "answer": "Use saved-note availability.",
                }
            ]
        ),
    )

    def fake_exec(_root, _step_dir, prompt, _label):
        prompts.append(prompt)
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

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "requirements-definition",
            "CHG-001",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "Interactive status: complete" in output
    assert "Which success condition was intended?" in prompts[0]
    assert "Use saved-note availability." in prompts[0]
    session_path = next((tmp_path / ".harness/runs").glob("*/grill-me-session.json"))
    session = json.loads(session_path.read_text(encoding="utf-8"))
    assert session["answers"][0]["source"] == "rerun_ui"


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
                "changed_files": ["docs/design/ubiquitous-language.md"],
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
                    "changed_files": ["docs/design/ubiquitous-language.md"],
                    "blocker": "",
                }
            )
        return json.dumps(
            {
                "status": "complete",
                "questions": [],
                "changed_files": ["docs/design/ubiquitous-language.md"],
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
                "changed_files": ["docs/design/ubiquitous-language.md"],
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


def test_procedure_implementation_stage_uses_two_hour_timeout(
    monkeypatch,
) -> None:
    monkeypatch.delenv("HARNESS_PROCEDURE_STAGE_TIMEOUT_SECONDS", raising=False)

    assert cli._procedure_stage_timeout_sec("implementation") == 7200
    assert cli._procedure_stage_timeout_sec("event-storming") == 3600


def test_implementation_parser_accepts_force_verification() -> None:
    args = cli.build_parser().parse_args(
        ["implementation", "CHG-001", "--apply", "--force-verification"]
    )

    assert args.force_verification is True


def test_implementation_parser_accepts_rollback_mode() -> None:
    args = cli.build_parser().parse_args(
        ["implementation", "CHG-001", "--apply", "--rollback", "safe"]
    )

    assert args.rollback == "safe"


def test_implementation_execution_summary_reports_resume_attempt() -> None:
    result = SimpleNamespace(
        step_results=(
            SimpleNamespace(metadata={"execution_mode": "resumed", "attempt": 2}),
        )
    )

    assert cli._implementation_execution_summary(result) == (
        " execution_mode=resumed attempt=2"
    )


def test_procedure_stage_timeout_can_be_overridden(
    monkeypatch,
) -> None:
    monkeypatch.setenv("HARNESS_PROCEDURE_STAGE_TIMEOUT_SECONDS", "17")

    assert cli._procedure_stage_timeout_sec("implementation") == 17
    assert cli._procedure_stage_timeout_sec("event-storming") == 17


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


def test_run_app_command_forwards_args_and_exit_code(
    tmp_path: Path,
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_start_app(repo_root, app_args, *, timeout):
        captured["repo_root"] = repo_root
        captured["app_args"] = app_args
        captured["timeout"] = timeout
        return 7

    monkeypatch.setattr(cli, "start_app", fake_start_app)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "run",
            "app",
            "--timeout",
            "12",
            "--",
            "--profile",
            "local",
        ]
    )

    assert exit_code == 7
    assert captured == {
        "repo_root": tmp_path,
        "app_args": ["--profile", "local"],
        "timeout": 12,
    }


def test_run_app_foreground_preserves_legacy_launcher(
    tmp_path: Path,
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_run_app(repo_root, app_args):
        captured["repo_root"] = repo_root
        captured["app_args"] = app_args
        return 9

    monkeypatch.setattr(cli, "run_app", fake_run_app)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "run",
            "app",
            "--foreground",
            "--",
            "--profile",
            "local",
        ]
    )

    assert exit_code == 9
    assert captured == {
        "repo_root": tmp_path,
        "app_args": ["--profile", "local"],
    }


def test_run_app_lifecycle_commands(tmp_path: Path, monkeypatch, capsys) -> None:
    attached: list[tuple[Path, str]] = []
    monkeypatch.setattr(cli, "app_status", lambda root: "status-output")
    monkeypatch.setattr(cli, "stop_app", lambda root: "stop-output")
    monkeypatch.setattr(
        cli,
        "attach_app",
        lambda root, component: attached.append((root, component)),
    )

    assert main(["--repo-root", str(tmp_path), "run", "app", "status"]) == 0
    assert capsys.readouterr().out.strip() == "status-output"
    assert main(["--repo-root", str(tmp_path), "run", "app", "stop"]) == 0
    assert capsys.readouterr().out.strip() == "stop-output"
    assert (
        main(
            [
                "--repo-root",
                str(tmp_path),
                "run",
                "app",
                "attach",
                "server",
            ]
        )
        == 0
    )
    assert attached == [(tmp_path, "server")]


def test_run_app_attach_requires_component(tmp_path: Path, capsys) -> None:
    exit_code = main(
        ["--repo-root", str(tmp_path), "run", "app", "attach"]
    )

    assert exit_code == 2
    assert "usage: harness run app attach infra|server" in capsys.readouterr().err


def test_run_wiki_command_defaults_to_serve(
    tmp_path: Path,
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}

    def fake_run_wiki(repo_root, action, *, dev_addr):
        captured.update(repo_root=repo_root, action=action, dev_addr=dev_addr)
        return 0

    monkeypatch.setattr(cli, "run_wiki", fake_run_wiki)

    assert main(["--repo-root", str(tmp_path), "run", "wiki"]) == 0
    assert captured == {
        "repo_root": tmp_path,
        "action": "serve",
        "dev_addr": "127.0.0.1:8000",
    }


def test_run_wiki_build_dispatches_action(
    tmp_path: Path,
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}
    monkeypatch.setattr(
        cli,
        "run_wiki",
        lambda repo_root, action, *, dev_addr: captured.update(
            repo_root=repo_root,
            action=action,
            dev_addr=dev_addr,
        )
        or 3,
    )

    assert main(["--repo-root", str(tmp_path), "run", "wiki", "build"]) == 3
    assert captured["action"] == "build"


def test_help_command_outputs_run_app_topic(tmp_path: Path, capsys) -> None:
    exit_code = main(["--repo-root", str(tmp_path), "help", "run"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "harness run app [--timeout SECONDS]" in output
    assert "harness run app status|stop|attach infra|server" in output
    assert "harness run wiki [serve|build|install]" in output


def test_implementation_apply_delegates_selected_changeset_to_runtime(
    tmp_path: Path,
    capsys,
    monkeypatch,
) -> None:
    write_changeset(tmp_path)
    captured: dict[str, object] = {}

    def fake_run_change_command(args, repo_root):
        captured["change_set_id"] = args.change_set_id
        captured["apply"] = args.apply
        captured["repo_root"] = repo_root
        return "APPLY started: run_id=run-001 status=succeeded"

    monkeypatch.setattr(cli, "run_change_command", fake_run_change_command)

    exit_code = main(
        [
            "--repo-root",
            str(tmp_path),
            "implementation",
            "CHG-001",
            "--apply",
        ]
    )

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "APPLY started: run_id=run-001 status=succeeded" in output
    assert captured == {
        "change_set_id": "CHG-001",
        "apply": True,
        "repo_root": tmp_path,
    }


def test_report_command_reads_report_markdown(tmp_path: Path, capsys) -> None:
    report_dir = tmp_path / ".harness/runs/run-001"
    report_dir.mkdir(parents=True)
    (report_dir / "report.md").write_text("# Run Report\n", encoding="utf-8")

    exit_code = main(["--repo-root", str(tmp_path), "report", "run-001"])

    output = capsys.readouterr().out
    assert exit_code == 0
    assert "# Run Report" in output
