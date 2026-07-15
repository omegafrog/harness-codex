"""Bootstrap compact repo-local agent context files."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re

from harness_codex.runtime.repo_analyzer import (
    LlmRepoSummary,
    RepoAnalysis,
    analyze_repository,
    analysis_to_markdown,
    summarize_repository_with_llm,
)
from harness_codex.runtime.scope_support_manifest import ensure_scope_support_manifest


HARNESS_AGENT_CONTEXT_MARKER = "<!-- harness-agent-context:v1 -->"
HARNESS_REVERSE_ENGINEERED_MARKER = "<!-- harness-reverse-engineered:v1 -->"
AGENT_CONTEXT_FILES = (
    Path("AGENTS.md"),
    Path(".harness/docs/agent/context.md"),
    Path(".harness/docs/agent/commands.md"),
    Path(".harness/docs/agent/session-state.md"),
    Path(".harness/docs/agent/codebase-artifacts.md"),
    Path(".harness/docs/agent/design-conformance-report.md"),
    Path(".harness/docs/agent/token-reduction-report.md"),
)


@dataclass(frozen=True)
class AgentContextFileResult:
    path: Path
    action: str


@dataclass(frozen=True)
class AgentContextBootstrapResult:
    files: tuple[AgentContextFileResult, ...]
    baseline_agent_words: int
    final_agent_words: int
    preserved_existing_agents: bool
    analyzer_mode: str = "static"
    llm_status: str = "skipped"
    llm_error: str = ""

    @property
    def changed_paths(self) -> tuple[Path, ...]:
        return tuple(
            item.path for item in self.files if item.action in {"created", "updated"}
        )


def bootstrap_agent_context(
    repo_root: Path | str,
    repo_description: str,
    *,
    force: bool = False,
    use_llm: bool = False,
) -> AgentContextBootstrapResult:
    """Create or update compact agent context files for a target repo."""

    repo = Path(repo_root)
    analysis = analyze_repository(repo, repo_description)
    llm_summary = summarize_repository_with_llm(repo, analysis, enabled=use_llm)
    description = (
        llm_summary.purpose.strip()
        or analysis.description
        or repo_description.strip()
        or "Repository managed by the harness workflow."
    )
    baseline_agent_words = _word_count(repo / "AGENTS.md")
    existing_agents_text = _read_text(repo / "AGENTS.md")
    preserve_agents = bool(
        existing_agents_text and HARNESS_AGENT_CONTEXT_MARKER not in existing_agents_text
    )

    rendered_docs = _render_docs(
        description=description,
        baseline_agent_words=baseline_agent_words,
        preserve_agents=preserve_agents,
        analysis=analysis,
        llm_summary=llm_summary,
    )
    results: list[AgentContextFileResult] = []

    for relative_path in AGENT_CONTEXT_FILES:
        absolute_path = repo / relative_path
        if relative_path == Path("AGENTS.md") and preserve_agents:
            results.append(AgentContextFileResult(relative_path, "preserved"))
            continue

        action = _write_if_changed(absolute_path, rendered_docs[relative_path])
        results.append(AgentContextFileResult(relative_path, action))

    results.extend(
        _write_reverse_engineered_artifacts(
            repo,
            llm_summary,
            force=force,
        )
    )
    support_manifest = ensure_scope_support_manifest(repo, description, refresh_if_stale=True)
    results.append(AgentContextFileResult(support_manifest.path, support_manifest.action))

    final_agent_words = _word_count(repo / "AGENTS.md")
    rendered_report = _render_token_reduction_report(
        baseline_agent_words=baseline_agent_words,
        final_agent_words=final_agent_words,
        doc_counts={
            path: _word_count(repo / path)
            for path in AGENT_CONTEXT_FILES
            if path != Path("AGENTS.md")
        },
        preserve_agents=preserve_agents,
        analysis=analysis,
        llm_summary=llm_summary,
    )
    report_path = repo / ".harness/docs/agent/token-reduction-report.md"
    report_action = _write_if_changed(report_path, rendered_report)
    results = [
        AgentContextFileResult(item.path, report_action)
        if item.path == Path(".harness/docs/agent/token-reduction-report.md")
        else item
        for item in results
    ]

    return AgentContextBootstrapResult(
        files=tuple(results),
        baseline_agent_words=baseline_agent_words,
        final_agent_words=final_agent_words,
        preserved_existing_agents=preserve_agents,
        analyzer_mode="static+llm" if use_llm else "static",
        llm_status=llm_summary.status,
        llm_error=llm_summary.error,
    )


def _render_docs(
    *,
    description: str,
    baseline_agent_words: int,
    preserve_agents: bool,
    analysis: RepoAnalysis,
    llm_summary: LlmRepoSummary,
) -> dict[Path, str]:
    return {
        Path("AGENTS.md"): _render_agents(description, analysis),
        Path(".harness/docs/agent/context.md"): _render_context(
            description, analysis, llm_summary
        ),
        Path(".harness/docs/agent/commands.md"): _render_commands(analysis, llm_summary),
        Path(".harness/docs/agent/session-state.md"): _render_session_state(
            preserve_agents=preserve_agents,
            analysis=analysis,
            llm_summary=llm_summary,
        ),
        Path(".harness/docs/agent/codebase-artifacts.md"): _render_codebase_artifacts(
            analysis, llm_summary
        ),
        Path(".harness/docs/agent/design-conformance-report.md"): _render_design_conformance(
            analysis, llm_summary
        ),
        Path(".harness/docs/agent/token-reduction-report.md"): _render_token_reduction_report(
            baseline_agent_words=baseline_agent_words,
            final_agent_words=0,
            doc_counts={},
            preserve_agents=preserve_agents,
            analysis=analysis,
            llm_summary=llm_summary,
        ),
    }


def _render_agents(description: str, analysis: RepoAnalysis) -> str:
    source_roots = _markdown_list(analysis.source_roots, default="source roots not detected")
    test_roots = _markdown_list(analysis.test_roots, default="test roots not detected")
    return f"""# Agent Context
{HARNESS_AGENT_CONTEXT_MARKER}

Write internal agent input/output in English. Write workflow artifact Markdown documents and user questions in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and previously approved canonical terms when compatibility requires their original form.

This repo is: {description}

Detected stack: {_comma(analysis.technologies)}.

## Fast Context
- Repo map: `.harness/docs/agent/context.md`
- Commands and verification: `.harness/docs/agent/commands.md`
- Current handoff state: `.harness/docs/agent/session-state.md`
- Existing-code artifacts: `.harness/docs/agent/codebase-artifacts.md`
- Design conformance: `.harness/docs/agent/design-conformance-report.md`
- Token-reduction report: `.harness/docs/agent/token-reduction-report.md`
- Module-specific guidance: nearest nested `AGENTS.md`

Read only the smallest relevant context file. Prefer `rg`, targeted file reads, Serena, Graphify, `harness memory cache`, and `harness memory graph` over broad dumps. Routine internal chatter must use concise English, but workflow artifact Markdown documents, PR bodies, source code, code comments, and user questions must use Korean.

## Detected Roots
- Source: {source_roots}
- Tests: {test_roots}

## Hard Rules
- Preserve project-specific rules from existing local docs and config.
- Human-readable Markdown documents created or updated by workflow steps must use Korean for titles, headings, prose, table labels, statuses, findings, questions, recommended answers, and user-visible examples.
- Use the repo-preferred runtime and dependency manager.
- Preserve ChangeSet, use-case, maintenance, and plan workflow boundaries when present.
- Do not edit runtime code unless the task explicitly requires it.
- Do not overwrite unrelated worktree changes.

## PR Body Requirements
Each PR must include:
- Implementation intent
- Implementation approach
- Verification method
- Risks and rollback

## Output Budget
- Cap routine command output near 4k tokens.
- Use concise status commands.
- Use diff stats before targeted diffs.
- Summarize logs/tests instead of pasting full output.
"""


def _render_context(
    description: str,
    analysis: RepoAnalysis,
    llm_summary: LlmRepoSummary,
) -> str:
    llm_module_map = _optional_section("LLM Module Map", llm_summary.module_map)
    llm_guidance = _optional_section(
        "LLM Context Guidance", llm_summary.context_guidance
    )
    return f"""# Agent Context Map

## Repository Purpose

{description}

## Static Analysis

{analysis_to_markdown(analysis)}

## Main Paths

- `AGENTS.md`: hot-path agent rules.
- `.harness/docs/agent/`: cold-path agent context, commands, session state, and token reports.
- `docs/design/`: canonical requirements and design documents when present.
- `docs/changes/`: active and completed ChangeSet documents when present.
- `docs/use-cases/`: executor-facing use-case slices when present.
- `docs/maintenance/`: executor-facing maintenance slices when present.
- `docs/plans/`: active and completed implementation plans when present.
- Source and test paths: discover with `rg --files`, package manifests, and build config.

## Context Loading Guidance

Start with the nearest `AGENTS.md`, then read only the smallest relevant file from `.harness/docs/agent/`. Prefer targeted search and symbol tools. Avoid broad design-doc or source dumps unless needed for the current decision.

## Harness Workflow Guidance

When ChangeSet docs exist, use the active ChangeSet and selected work-item slice as the primary scope. Read canonical design docs only when the slice points there or shared design context is required.
{llm_module_map}{llm_guidance}
"""


def _render_commands(analysis: RepoAnalysis, llm_summary: LlmRepoSummary) -> str:
    detected_commands = "\n".join(
        f"- {item.label}: `{item.command}`" for item in analysis.commands
    )
    detected_commands = detected_commands or "- none detected"
    llm_notes = _optional_section("LLM Command Notes", llm_summary.command_notes)
    return f"""# Agent Commands

## Discovery

{detected_commands}

## Harness Commands

- Start requirements stage: `python3 -m harness_codex requirements-definition <CHG-ID> --title "<title>" --idea "<idea>"`
- List active ChangeSets: `python3 -m harness_codex changes list`
- Initialize repo context: `python3 -m harness_codex init --description "<repo description>"`
- Create ChangeSet and run affected workflows: `python3 -m harness_codex ultrawork --title "<title>" --preview`
- Run use-case stage: `python3 -m harness_codex use-case-definition <CHG-ID>`
- Preview ChangeSet implementation with one execution loop per affected UC: `python3 -m harness_codex implementation <CHG-ID> --preview`
- Bootstrap agent context: `python3 -m harness_codex agent-context init --description "<repo description>"`
- 검토된 메모리 검색: `python3 -m harness_codex memory search "<query>" --limit 3`
- 반복되는 미변경 파일 캐시 읽기: `python3 -m harness_codex memory cache read <path>`
- 로컬 Ollama/Graphify로 설계/소스 그래프 컨텍스트 생성: `python3 -m harness_codex memory graph build docs/design <source-root>`
- 마지막 build manifest 기준 그래프 재생성: `python3 -m harness_codex memory graph rebuild`
- 넓은 스캔 전 그래프 컨텍스트 질의: `python3 -m harness_codex memory graph query "<question>" --budget 1200`
{llm_notes}

## Agent Context Verification

```bash
find . -name AGENTS.md -print | sort | xargs -r wc -w
wc -w .harness/docs/agent/*.md
rg -n -P "\\p{{Hangul}}" AGENTS.md .harness/docs/agent || true
git diff --stat
git status --porcelain=v1 -uno
```

## Output Budget

Use concise status commands first. Use diff stats before targeted diffs. Summarize logs and failures instead of pasting full output. Cap routine command output near 4k tokens.
"""


def _render_codebase_artifacts(
    analysis: RepoAnalysis,
    llm_summary: LlmRepoSummary,
) -> str:
    details = llm_summary.codebase_artifacts.strip()
    if not details:
        details = (
            "Semantic implementation artifacts were not generated because the LLM "
            f"analysis did not complete (status: {llm_summary.status}"
            f"{_status_error(llm_summary)}). Run `harness init` with LLM analysis "
            "enabled to reverse-engineer code-level behavior."
        )
    return f"""# Existing Codebase Artifacts

## Repository Inventory

{analysis_to_markdown(analysis)}

## Reverse-Engineered Implementation

{details}

## Evidence Policy

- Source and test paths are implementation evidence.
- Generated summaries are discovery aids, not canonical product requirements.
- Validate findings against current code before using them for workflow decisions.
"""


def _render_design_conformance(
    analysis: RepoAnalysis,
    llm_summary: LlmRepoSummary,
) -> str:
    report = llm_summary.design_conformance.strip()
    if not report:
        design_sources = _markdown_list(
            analysis.workflow_docs,
            default="none detected",
        )
        report = f"""## Assessment Status

Not assessed. LLM analysis status: {llm_summary.status}{_status_error(llm_summary)}.

## Evidence Reviewed

- Detected workflow-design sources: {design_sources}.
- Static inventory cannot establish semantic agreement between code and design.

## Mismatches

None reported. This means no semantic assessment completed; it does not mean the implementation conforms.

## Recommended Follow-up

Run `harness init` with LLM analysis enabled, then review every reported mismatch against cited code and design paths.
"""
    return f"""# Workflow Design Conformance Report

{report}

## Report Rules

- A mismatch requires implementation evidence and workflow-design evidence.
- Missing or ambiguous design is an unassessed area, not an implementation defect.
- This report is diagnostic. It does not modify code or canonical design artifacts.
"""


def _render_session_state(
    *,
    preserve_agents: bool,
    analysis: RepoAnalysis,
    llm_summary: LlmRepoSummary,
) -> str:
    agents_state = (
        "Existing unmarked root `AGENTS.md` was preserved."
        if preserve_agents
        else "Root `AGENTS.md` is harness-managed."
    )
    return f"""# Agent Session State

## Current State

- {agents_state}
- `.harness/docs/agent/` contains cold-path context generated by harness bootstrap.
- Existing-code artifacts and workflow-design conformance reports are available under `.harness/docs/agent/`.
- Analyzer mode: static repository scan.
- LLM summary status: {llm_summary.status}{_status_error(llm_summary)}.
- Detected technologies: {_comma(analysis.technologies)}.
- Check `git status --porcelain=v1 -uno` before modifying files.

## Handoff Rules

- Preserve unrelated staged and unstaged work.
- Keep human-readable Markdown workflow outputs in Korean while preserving compatibility-sensitive identifiers and canonical terms.
- Prefer targeted context reads over full-file dumps.
- Update this file when long-running work leaves important handoff state.
"""


def _render_token_reduction_report(
    *,
    baseline_agent_words: int,
    final_agent_words: int,
    doc_counts: dict[Path, int],
    preserve_agents: bool,
    analysis: RepoAnalysis,
    llm_summary: LlmRepoSummary,
) -> str:
    doc_rows = "\n".join(
        f"- `{path}`: {count} words" for path, count in sorted(doc_counts.items())
    )
    doc_rows = doc_rows or "- pending"
    root_note = (
        "Existing root `AGENTS.md` was preserved because it was not harness-managed."
        if preserve_agents
        else "Root `AGENTS.md` is managed by harness bootstrap."
    )
    return f"""# Token Reduction Report

## Baseline

- `AGENTS.md` word count before bootstrap: {baseline_agent_words} words.

## Result

- `AGENTS.md` word count after bootstrap: {final_agent_words} words.
- {root_note}
- Detailed repo context now lives under `.harness/docs/agent/`.
- Analyzer mode: static repository scan.
- LLM summary status: {llm_summary.status}{_status_error(llm_summary)}.
- Detected technologies: {_comma(analysis.technologies)}.

## Agent Doc Counts

{doc_rows}

## Verification Commands

```bash
find . -name AGENTS.md -print | sort | xargs -r wc -w
wc -w .harness/docs/agent/*.md
rg -n -P "\\p{{Hangul}}" AGENTS.md .harness/docs/agent || true
git diff --stat
git status --porcelain=v1 -uno
```
"""


def _write_if_changed(path: Path, text: str) -> str:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return "unchanged"
    path.parent.mkdir(parents=True, exist_ok=True)
    action = "updated" if path.exists() else "created"
    path.write_text(text, encoding="utf-8")
    return action


_REVERSE_ENGINEERED_EXACT_PATHS = {
    "docs/design/요구사항.md",
    "context.md",
    "docs/design/유스케이스.md",
    "docs/design/이벤트 스토밍.md",
    "ARCHITECTURE.md",
}
_REVERSE_ENGINEERED_SLICE_PATH = re.compile(
    r"docs/use-cases/UC-\d{3}/(?:use-case|e2e-goal|event-storming|ddd-design)\.md"
)


def _write_reverse_engineered_artifacts(
    repo: Path,
    llm_summary: LlmRepoSummary,
    *,
    force: bool,
) -> tuple[AgentContextFileResult, ...]:
    results: list[AgentContextFileResult] = []
    for raw_path, content in llm_summary.artifacts:
        relative_path = Path(raw_path)
        if not _is_allowed_reverse_engineered_path(relative_path):
            continue
        absolute_path = repo / relative_path
        existing = _read_text(absolute_path)
        if existing and not (
            force and HARNESS_REVERSE_ENGINEERED_MARKER in existing
        ) and not _is_installer_placeholder(relative_path, existing):
            results.append(AgentContextFileResult(relative_path, "preserved"))
            continue
        rendered = f"{HARNESS_REVERSE_ENGINEERED_MARKER}\n{content.rstrip()}\n"
        action = _write_if_changed(absolute_path, rendered)
        results.append(AgentContextFileResult(relative_path, action))
    return tuple(results)


def _is_allowed_reverse_engineered_path(path: Path) -> bool:
    text = path.as_posix()
    if path.is_absolute() or ".." in path.parts:
        return False
    return text in _REVERSE_ENGINEERED_EXACT_PATHS or bool(
        _REVERSE_ENGINEERED_SLICE_PATH.fullmatch(text)
    )


def _is_installer_placeholder(path: Path, text: str) -> bool:
    normalized = "\n".join(line.rstrip() for line in text.strip().splitlines())
    placeholders = {
        Path("ARCHITECTURE.md"): "# Architecture\n\nTBD",
        Path("docs/design/요구사항.md"): "# 요구사항\n\nTBD",
        Path("docs/design/유스케이스.md"): "# 유스케이스\n\nTBD",
    }
    return normalized == placeholders.get(path)


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def _word_count(path: Path) -> int:
    if not path.exists():
        return 0
    return len(path.read_text(encoding="utf-8").split())


def _markdown_list(paths: tuple[Path, ...], *, default: str) -> str:
    if not paths:
        return default
    return ", ".join(f"`{path.as_posix()}`" for path in paths)


def _comma(values: tuple[str, ...]) -> str:
    return ", ".join(values) if values else "none detected"


def _optional_section(title: str, body: str) -> str:
    if not body.strip():
        return ""
    return f"\n## {title}\n\n{body.strip()}\n"


def _status_error(summary: LlmRepoSummary) -> str:
    if not summary.error:
        return ""
    return f" ({summary.error})"
