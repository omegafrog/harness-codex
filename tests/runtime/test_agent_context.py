import re
from pathlib import Path

from harness_codex.runtime.agent_context import (
    AGENT_CONTEXT_FILES,
    HARNESS_AGENT_CONTEXT_MARKER,
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
    commands = (tmp_path / "docs/agent/commands.md").read_text(encoding="utf-8")
    assert "Python tests" in commands
    assert "python3 -m pytest -q -s" in commands


def test_bootstrap_agent_context_preserves_unmarked_agents(
    tmp_path: Path,
) -> None:
    agents = tmp_path / "AGENTS.md"
    agents.write_text("# Local Rules\n\nDo not overwrite.\n", encoding="utf-8")

    result = bootstrap_agent_context(tmp_path, "Sample project", force=True)

    assert agents.read_text(encoding="utf-8") == "# Local Rules\n\nDo not overwrite.\n"
    assert result.preserved_existing_agents is True
    assert (tmp_path / "docs/agent/context.md").is_file()
    session_state = (tmp_path / "docs/agent/session-state.md").read_text(
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


def test_bootstrap_agent_context_outputs_have_no_korean(
    tmp_path: Path,
) -> None:
    bootstrap_agent_context(tmp_path, "Sample project")

    combined = "\n".join(
        (tmp_path / path).read_text(encoding="utf-8")
        for path in AGENT_CONTEXT_FILES
    )
    assert re.search(r"[가-힣]", combined) is None


def test_bootstrap_agent_context_report_records_counts(tmp_path: Path) -> None:
    bootstrap_agent_context(tmp_path, "Sample project")

    report = (tmp_path / "docs/agent/token-reduction-report.md").read_text(
        encoding="utf-8"
    )
    assert "`AGENTS.md` word count before bootstrap: 0 words" in report
    assert "`AGENTS.md` word count after bootstrap:" in report
    assert "`docs/agent/context.md`:" in report
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
    session_state = (tmp_path / "docs/agent/session-state.md").read_text(
        encoding="utf-8"
    )
    assert "LLM summary status: blocked (quota)." in session_state
