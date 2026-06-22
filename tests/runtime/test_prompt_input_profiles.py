from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.prompt import build_agent_prompt


def _write_context(repo: Path) -> None:
    (repo / "AGENTS.md").write_text("# AGENTS\nROOT_MARKER\n", encoding="utf-8")
    agent_docs = repo / "docs/agent"
    agent_docs.mkdir(parents=True)
    (agent_docs / "context.md").write_text("CONTEXT_MARKER\n", encoding="utf-8")
    (agent_docs / "commands.md").write_text("COMMAND_MARKER\n", encoding="utf-8")
    (agent_docs / "session-state.md").write_text("SESSION_MARKER\n", encoding="utf-8")
    (agent_docs / "codebase-artifacts.md").write_text("UNRELATED_ARTIFACT_MARKER\n", encoding="utf-8")
    (agent_docs / "design-conformance-report.md").write_text("UNRELATED_DESIGN_MARKER\n", encoding="utf-8")

    codex_dir = repo / ".codex"
    codex_dir.mkdir(parents=True)
    (codex_dir / "repository-settings.md").write_text("SETTINGS_MARKER\n", encoding="utf-8")

    workflow_dir = repo / ".harness/workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "changeset-use-case-workflow.yaml").write_text(
        "WORKFLOW_BODY_MARKER " * 500,
        encoding="utf-8",
    )
    change_dir = repo / "docs/changes/active"
    change_dir.mkdir(parents=True)
    (change_dir / "CHG-001.md").write_text(
        "CHANGESET_BODY_MARKER " * 500,
        encoding="utf-8",
    )


def _context(repo: Path, *, include_session_state: bool = False) -> RunContext:
    return RunContext(
        run_id="run-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        repo_root=repo,
        workdir=repo,
        run_dir=repo / ".harness/runs/run-001",
        metadata={
            "change_set_id": "CHG-001",
            "change_set_path": "docs/changes/active/CHG-001.md",
            "active_work_item_id": "UC-001",
            "active_work_item_type": "use_case",
            "affected_work_items": [
                {
                    "id": "UC-001",
                    "type": "use_case",
                    "slice_path": "docs/use-cases/UC-001",
                    "secret_metadata": "MUST_NOT_APPEAR",
                }
            ],
            "include_session_state": include_session_state,
            "is_final_work_item": True,
            "unbounded_runtime_metadata": "MUST_NOT_APPEAR",
        },
    )


def _step(stage: str) -> Step:
    return Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="Execute work item",
        agent_id="implementation_executor",
        skill_id="harness-plan-executor",
        inputs=(
            Path("docs/plans/active/UC-001/plan.md"),
            Path(".codex/repository-settings.md"),
        ),
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
        metadata={
            "stage": stage,
            "scope": "work_item",
            "review_gate": {"approved_status": "approved"},
            "opaque_metadata": "MUST_NOT_APPEAR",
        },
    )


def _prompt(repo: Path, *, stage: str, include_session_state: bool = False) -> str:
    return build_agent_prompt(
        step=_step(stage),
        context=_context(repo, include_session_state=include_session_state),
        agent_config={"name": "implementation_executor", "description": "executor"},
        agent_config_path=Path(".codex/agents/implementation_executor.toml"),
        skill_path=repo / ".codex/skills/harness-plan-executor/SKILL.md",
    )


def test_execution_profile_is_small_and_excludes_unrelated_context(tmp_path: Path) -> None:
    _write_context(tmp_path)

    prompt = _prompt(tmp_path, stage="execution")

    assert "AGENTS.md" in prompt
    assert "docs/agent/commands.md" in prompt
    assert "docs/agent/context.md" not in prompt
    assert "docs/agent/session-state.md" not in prompt
    assert "codebase-artifacts.md" not in prompt
    assert "design-conformance-report.md" not in prompt
    assert "ROOT_MARKER" not in prompt
    assert "COMMAND_MARKER" not in prompt
    assert "SESSION_MARKER" not in prompt


def test_plan_profile_can_opt_in_to_session_state(tmp_path: Path) -> None:
    _write_context(tmp_path)

    prompt = _prompt(tmp_path, stage="plan", include_session_state=True)

    assert "docs/agent/context.md" in prompt
    assert "docs/agent/commands.md" in prompt
    assert "docs/agent/session-state.md" in prompt
    assert "SESSION_MARKER" not in prompt


def test_prompt_uses_references_not_full_workflow_or_unbounded_metadata(tmp_path: Path) -> None:
    _write_context(tmp_path)

    prompt = _prompt(tmp_path, stage="security-verification")

    assert "WORKFLOW_BODY_MARKER" not in prompt
    assert "CHANGESET_BODY_MARKER" not in prompt
    assert "MUST_NOT_APPEAR" not in prompt
    assert '"is_final_work_item": true' in prompt
    assert '"stage": "security-verification"' in prompt
    assert '"opaque_metadata"' not in prompt
    assert "docs/changes/active/CHG-001.md" in prompt


def test_missing_optional_profile_file_is_omitted(tmp_path: Path) -> None:
    (tmp_path / "AGENTS.md").write_text("# AGENTS\n", encoding="utf-8")

    prompt = _prompt(tmp_path, stage="execution")

    assert "<not found>" not in prompt
    assert "docs/agent/commands.md" not in prompt


def test_context_cache_retains_audit_content_without_prompt_preview(tmp_path: Path) -> None:
    _write_context(tmp_path)

    prompt = _prompt(tmp_path, stage="plan")

    cache_files = tuple((tmp_path / ".harness/cache/prompt-context").glob("*.md"))
    assert cache_files
    assert any("CONTEXT_MARKER" in path.read_text(encoding="utf-8") for path in cache_files)
    assert "CONTEXT_MARKER" not in prompt
    assert "Preview:" not in prompt
