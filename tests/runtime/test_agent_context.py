from pathlib import Path

from harness_codex.runtime.agent_context import (
    AGENT_CONTEXT_FILES,
    HARNESS_AGENT_CONTEXT_MARKER,
    HARNESS_REVERSE_ENGINEERED_MARKER,
    bootstrap_agent_context,
)
from harness_codex.runtime.repo_analyzer import LlmRepoSummary


def test_bootstrap_agent_context_creates_expected_files(tmp_path: Path) -> None:
    (tmp_path / "pyproject.toml").write_text("[project]\nname='sample'\n", encoding="utf-8")
    (tmp_path / "tests").mkdir()
    result = bootstrap_agent_context(tmp_path, "Sample project")

    assert result.baseline_agent_words == 0
    assert result.final_agent_words > 0
    for path in AGENT_CONTEXT_FILES:
        assert (tmp_path / path).is_file()
    assert HARNESS_AGENT_CONTEXT_MARKER in (tmp_path / "AGENTS.md").read_text(
        encoding="utf-8"
    )
    commands = (tmp_path / ".harness/docs/agent/commands.md").read_text(encoding="utf-8")
    assert "Python tests" in commands
    assert "python3 -m pytest -q -s" in commands
    artifacts = (tmp_path / ".harness/docs/agent/codebase-artifacts.md").read_text(
        encoding="utf-8"
    )
    assert "Existing Codebase Artifacts" in artifacts
    conformance = (tmp_path / ".harness/docs/agent/design-conformance-report.md").read_text(
        encoding="utf-8"
    )
    assert "Not assessed" in conformance
    assert "does not mean the implementation conforms" in conformance


def test_bootstrap_agent_context_preserves_unmarked_agents(
    tmp_path: Path,
) -> None:
    agents = tmp_path / "AGENTS.md"
    agents.write_text("# Local Rules\n\nDo not overwrite.\n", encoding="utf-8")

    result = bootstrap_agent_context(tmp_path, "Sample project", force=True)

    assert agents.read_text(encoding="utf-8") == "# Local Rules\n\nDo not overwrite.\n"
    assert result.preserved_existing_agents is True
    assert (tmp_path / ".harness/docs/agent/context.md").is_file()
    session_state = (tmp_path / ".harness/docs/agent/session-state.md").read_text(
        encoding="utf-8"
    )
    assert "Existing unmarked root `AGENTS.md` was preserved." in session_state


def test_bootstrap_agent_context_updates_managed_agents_with_force(
    tmp_path: Path,
) -> None:
    bootstrap_agent_context(tmp_path, "Old description")

    result = bootstrap_agent_context(tmp_path, "New description", force=True)

    agents = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
    assert "New description" in agents
    assert result.preserved_existing_agents is False


def test_bootstrap_agent_context_updates_managed_agents_without_force(
    tmp_path: Path,
) -> None:
    bootstrap_agent_context(tmp_path, "Old description")

    bootstrap_agent_context(tmp_path, "New description")

    agents = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
    assert "New description" in agents


def test_bootstrap_agent_context_requires_korean_workflow_documents(
    tmp_path: Path,
) -> None:
    bootstrap_agent_context(tmp_path, "Sample project")

    agents = (tmp_path / "AGENTS.md").read_text(encoding="utf-8")
    session_state = (tmp_path / ".harness/docs/agent/session-state.md").read_text(
        encoding="utf-8"
    )
    assert "Write all agent input/output and user-facing output in Korean." in agents
    assert "Human-readable Markdown documents" in agents
    assert "titles, headings, prose, table labels, statuses, findings" in agents
    assert "Keep human-readable Markdown workflow outputs in Korean" in session_state


def test_bootstrap_agent_context_report_records_counts(tmp_path: Path) -> None:
    bootstrap_agent_context(tmp_path, "Sample project")

    report = (tmp_path / ".harness/docs/agent/token-reduction-report.md").read_text(
        encoding="utf-8"
    )
    assert "`AGENTS.md` word count before bootstrap: 0 words" in report
    assert "`AGENTS.md` word count after bootstrap:" in report
    assert "`.harness/docs/agent/context.md`:" in report
    assert "Analyzer mode: static repository scan." in report


def test_bootstrap_agent_context_falls_back_when_llm_blocks(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "harness_codex.runtime.agent_context.summarize_repository_with_llm",
        lambda *_args, **_kwargs: LlmRepoSummary(status="blocked", error="quota"),
    )

    result = bootstrap_agent_context(tmp_path, "Sample project", use_llm=True)

    assert result.llm_status == "blocked"
    assert result.llm_error == "quota"
    session_state = (tmp_path / ".harness/docs/agent/session-state.md").read_text(
        encoding="utf-8"
    )
    assert "LLM summary status: blocked (quota)." in session_state
    conformance = (tmp_path / ".harness/docs/agent/design-conformance-report.md").read_text(
        encoding="utf-8"
    )
    assert "Not assessed. LLM analysis status: blocked (quota)." in conformance


def test_bootstrap_agent_context_writes_llm_codebase_and_conformance_reports(
    tmp_path: Path,
    monkeypatch,
) -> None:
    (tmp_path / "src").mkdir()
    (tmp_path / "src/app.py").write_text("print('ok')\n", encoding="utf-8")
    (tmp_path / "docs/design").mkdir(parents=True)
    (tmp_path / "docs/design/requirements.md").write_text(
        "# Requirements\n", encoding="utf-8"
    )
    monkeypatch.setattr(
        "harness_codex.runtime.agent_context.summarize_repository_with_llm",
        lambda *_args, **_kwargs: LlmRepoSummary(
            status="completed",
            codebase_artifacts="- Entry point: `src/app.py`.",
            design_conformance=(
                "## Assessment Status\n\nCompleted.\n\n"
                "## Mismatches\n\n- `src/app.py` conflicts with "
                "`docs/design/requirements.md`: sample mismatch."
            ),
            artifacts=(
                (
                    "docs/design/요구사항.md",
                    "# Requirements\n\n## 1. Scope\n\n- Existing behavior.",
                ),
                (
                    "docs/use-cases/UC-001/event-storming.md",
                    "# UC-001 Event Storming\n\n## Commands\n\n- Start operation.",
                ),
            ),
        ),
    )

    bootstrap_agent_context(tmp_path, "Sample project", use_llm=True)

    artifacts = (tmp_path / ".harness/docs/agent/codebase-artifacts.md").read_text(
        encoding="utf-8"
    )
    conformance = (tmp_path / ".harness/docs/agent/design-conformance-report.md").read_text(
        encoding="utf-8"
    )
    assert "Entry point: `src/app.py`" in artifacts
    assert "sample mismatch" in conformance
    requirements = (tmp_path / "docs/design/요구사항.md").read_text(
        encoding="utf-8"
    )
    assert HARNESS_REVERSE_ENGINEERED_MARKER in requirements
    assert "Existing behavior" in requirements
    assert (tmp_path / "docs/use-cases/UC-001/event-storming.md").is_file()


def test_bootstrap_preserves_existing_design_artifact_without_force(
    tmp_path: Path,
    monkeypatch,
) -> None:
    requirements = tmp_path / "docs/design/요구사항.md"
    requirements.parent.mkdir(parents=True)
    requirements.write_text("# User Requirements\n", encoding="utf-8")
    monkeypatch.setattr(
        "harness_codex.runtime.agent_context.summarize_repository_with_llm",
        lambda *_args, **_kwargs: LlmRepoSummary(
            status="completed",
            artifacts=(("docs/design/요구사항.md", "# Generated Requirements"),),
        ),
    )

    result = bootstrap_agent_context(tmp_path, "Sample project", use_llm=True)

    assert requirements.read_text(encoding="utf-8") == "# User Requirements\n"
    assert any(
        item.path == Path("docs/design/요구사항.md") and item.action == "preserved"
        for item in result.files
    )


def test_bootstrap_replaces_installer_design_placeholders(
    tmp_path: Path,
    monkeypatch,
) -> None:
    requirements = tmp_path / "docs/design/요구사항.md"
    requirements.parent.mkdir(parents=True)
    requirements.write_text("# 요구사항\n\nTBD\n", encoding="utf-8")
    monkeypatch.setattr(
        "harness_codex.runtime.agent_context.summarize_repository_with_llm",
        lambda *_args, **_kwargs: LlmRepoSummary(
            status="completed",
            artifacts=(("docs/design/요구사항.md", "# Requirements\n\nObserved."),),
        ),
    )

    bootstrap_agent_context(tmp_path, "Sample project", use_llm=True)

    generated = requirements.read_text(encoding="utf-8")
    assert HARNESS_REVERSE_ENGINEERED_MARKER in generated
    assert "Observed." in generated


def test_bootstrap_rejects_reverse_engineered_artifact_outside_allowlist(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "harness_codex.runtime.agent_context.summarize_repository_with_llm",
        lambda *_args, **_kwargs: LlmRepoSummary(
            status="completed",
            artifacts=(("src/generated.py", "print('unsafe')"),),
        ),
    )

    bootstrap_agent_context(tmp_path, "Sample project", use_llm=True)

    assert not (tmp_path / "src/generated.py").exists()
