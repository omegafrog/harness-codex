"""Bootstrap compact repo-local agent context files."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


HARNESS_AGENT_CONTEXT_MARKER = "<!-- harness-agent-context:v1 -->"
AGENT_CONTEXT_FILES = (
    Path("AGENTS.md"),
    Path("docs/agent/context.md"),
    Path("docs/agent/commands.md"),
    Path("docs/agent/session-state.md"),
    Path("docs/agent/token-reduction-report.md"),
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
) -> AgentContextBootstrapResult:
    """Create or update compact agent context files for a target repo."""

    repo = Path(repo_root)
    description = repo_description.strip() or "Repository managed by the harness workflow."
    baseline_agent_words = _word_count(repo / "AGENTS.md")
    existing_agents_text = _read_text(repo / "AGENTS.md")
    preserve_agents = bool(
        existing_agents_text and HARNESS_AGENT_CONTEXT_MARKER not in existing_agents_text
    )

    rendered_docs = _render_docs(
        description=description,
        baseline_agent_words=baseline_agent_words,
        preserve_agents=preserve_agents,
    )
    results: list[AgentContextFileResult] = []

    for relative_path in AGENT_CONTEXT_FILES:
        absolute_path = repo / relative_path
        if relative_path == Path("AGENTS.md") and preserve_agents:
            results.append(AgentContextFileResult(relative_path, "preserved"))
            continue

        action = _write_if_changed(absolute_path, rendered_docs[relative_path])
        results.append(AgentContextFileResult(relative_path, action))

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
    )
    report_path = repo / "docs/agent/token-reduction-report.md"
    report_action = _write_if_changed(report_path, rendered_report)
    results = [
        AgentContextFileResult(item.path, report_action)
        if item.path == Path("docs/agent/token-reduction-report.md")
        else item
        for item in results
    ]

    return AgentContextBootstrapResult(
        files=tuple(results),
        baseline_agent_words=baseline_agent_words,
        final_agent_words=final_agent_words,
        preserved_existing_agents=preserve_agents,
    )


def _render_docs(
    *,
    description: str,
    baseline_agent_words: int,
    preserve_agents: bool,
) -> dict[Path, str]:
    return {
        Path("AGENTS.md"): _render_agents(description),
        Path("docs/agent/context.md"): _render_context(description),
        Path("docs/agent/commands.md"): _render_commands(),
        Path("docs/agent/session-state.md"): _render_session_state(
            preserve_agents=preserve_agents
        ),
        Path("docs/agent/token-reduction-report.md"): _render_token_reduction_report(
            baseline_agent_words=baseline_agent_words,
            final_agent_words=0,
            doc_counts={},
            preserve_agents=preserve_agents,
        ),
    }


def _render_agents(description: str) -> str:
    return f"""# Agent Context
{HARNESS_AGENT_CONTEXT_MARKER}

Write all agent input/output and user-facing output in English.

This repo is: {description}

## Fast Context
- Repo map: `docs/agent/context.md`
- Commands and verification: `docs/agent/commands.md`
- Current handoff state: `docs/agent/session-state.md`
- Token-reduction report: `docs/agent/token-reduction-report.md`
- Module-specific guidance: nearest nested `AGENTS.md`

Read only the smallest relevant context file. Prefer `rg`, targeted file reads, Serena, and Graphify over broad dumps. Use concise output for routine work.

## Hard Rules
- Preserve project-specific rules from existing local docs and config.
- Documents created or updated under `docs/` must be written in English unless the repo explicitly requires another language.
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


def _render_context(description: str) -> str:
    return f"""# Agent Context Map

## Repository Purpose

{description}

## Main Paths

- `AGENTS.md`: hot-path agent rules.
- `docs/agent/`: cold-path agent context, commands, session state, and token reports.
- `docs/design/`: canonical requirements and design documents when present.
- `docs/changes/`: active and completed ChangeSet documents when present.
- `docs/use-cases/`: executor-facing use-case slices when present.
- `docs/maintenance/`: executor-facing maintenance slices when present.
- `docs/plans/`: active and completed implementation plans when present.
- Source and test paths: discover with `rg --files`, package manifests, and build config.

## Context Loading Guidance

Start with the nearest `AGENTS.md`, then read only the smallest relevant file from `docs/agent/`. Prefer targeted search and symbol tools. Avoid broad design-doc or source dumps unless needed for the current decision.

## Harness Workflow Guidance

When ChangeSet docs exist, use the active ChangeSet and selected work-item slice as the primary scope. Read canonical design docs only when the slice points there or shared design context is required.
"""


def _render_commands() -> str:
    return """# Agent Commands

## Discovery

- List files: `rg --files`
- Search text: `rg -n "<pattern>"`
- Git status: `git status --porcelain=v1 -uno`
- Diff stat: `git diff --stat`

## Harness Commands

- Harvest plan: `python3 -m harness_codex harvest --idea "<idea>" --plan`
- Create ChangeSet from design: `python3 -m harness_codex changes create-from-design --title "<title>"`
- List active ChangeSets: `python3 -m harness_codex changes list`
- Preview use-case workflow: `python3 -m harness_codex run-use-case <CHG-ID> <UC-ID> --preview`
- Bootstrap agent context: `python3 -m harness_codex agent-context init --description "<repo description>"`

## Agent Context Verification

```bash
find . -name AGENTS.md -print | sort | xargs -r wc -w
wc -w docs/agent/*.md
rg -n -P "\\p{Hangul}" AGENTS.md docs/agent || true
git diff --stat
git status --porcelain=v1 -uno
```

## Output Budget

Use concise status commands first. Use diff stats before targeted diffs. Summarize logs and failures instead of pasting full output. Cap routine command output near 4k tokens.
"""


def _render_session_state(*, preserve_agents: bool) -> str:
    agents_state = (
        "Existing unmarked root `AGENTS.md` was preserved."
        if preserve_agents
        else "Root `AGENTS.md` is harness-managed."
    )
    return f"""# Agent Session State

## Current State

- {agents_state}
- `docs/agent/` contains cold-path context generated by harness bootstrap.
- Check `git status --porcelain=v1 -uno` before modifying files.

## Handoff Rules

- Preserve unrelated staged and unstaged work.
- Keep generated docs in English unless the repository explicitly requires another language.
- Prefer targeted context reads over full-file dumps.
- Update this file when long-running work leaves important handoff state.
"""


def _render_token_reduction_report(
    *,
    baseline_agent_words: int,
    final_agent_words: int,
    doc_counts: dict[Path, int],
    preserve_agents: bool,
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
- Detailed repo context now lives under `docs/agent/`.

## Agent Doc Counts

{doc_rows}

## Verification Commands

```bash
find . -name AGENTS.md -print | sort | xargs -r wc -w
wc -w docs/agent/*.md
rg -n -P "\\p{{Hangul}}" AGENTS.md docs/agent || true
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


def _read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def _word_count(path: Path) -> int:
    if not path.exists():
        return 0
    return len(path.read_text(encoding="utf-8").split())
