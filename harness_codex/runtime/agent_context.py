"""Bootstrap compact repo-local agent context files."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

HARNESS_AGENT_CONTEXT_MARKER = "<!-- harness-agent-context:v1 -->"
AGENT_CONTEXT_FILES = (
    Path("AGENTS.md"),
    Path("docs/agent/context.md"),
    Path("docs/agent/commands.md"),
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
        return tuple(item.path for item in self.files if item.action in {"created", "updated"})


def bootstrap_agent_context(repo_root: Path | str, repo_description: str, *, force: bool = False) -> AgentContextBootstrapResult:
    del force
    repo = Path(repo_root)
    description = repo_description.strip() or "Repository managed by the harness workflow."
    baseline = _word_count(repo / "AGENTS.md")
    existing = _read_text(repo / "AGENTS.md")
    preserve = bool(existing and HARNESS_AGENT_CONTEXT_MARKER not in existing)
    docs = _render_docs(description)
    results: list[AgentContextFileResult] = []
    for relative_path in AGENT_CONTEXT_FILES:
        if relative_path == Path("AGENTS.md") and preserve:
            results.append(AgentContextFileResult(relative_path, "preserved"))
        else:
            results.append(AgentContextFileResult(relative_path, _write_if_changed(repo / relative_path, docs[relative_path])))
    return AgentContextBootstrapResult(tuple(results), baseline, _word_count(repo / "AGENTS.md"), preserve)


def _render_docs(description: str) -> dict[Path, str]:
    return {
        Path("AGENTS.md"): f"# Agent Context\n{HARNESS_AGENT_CONTEXT_MARKER}\n\nThis repo is: {description}\n\n- Read `docs/agent/context.md` for scope.\n- Read `docs/agent/commands.md` for canonical runtime commands.\n- `RunState` in `.harness/runs/<RUN-ID>/state.json` is authoritative for runtime status and resume.\n",
        Path("docs/agent/context.md"): f"# Agent Context Map\n\n{description}\n\nRead the active ChangeSet, selected work-item slice, current plan, then `RunState`. Do not create a parallel session or procedure state.\n",
        Path("docs/agent/commands.md"): "# Agent Commands\n\n- `python3 -m harness_codex harvest --idea \"<request>\" --apply --session-id harvest-001`\n- `python3 -m harness_codex changes create-from-design --title \"<title>\"`\n- `python3 -m harness_codex changes active`\n- `python3 -m harness_codex run-change <CHG-ID> --apply`\n- `python3 -m harness_codex run-work-item <CHG-ID> <WORK-ITEM-ID> --apply`\n- `python3 -m harness_codex resume <RUN-ID>`\n\nLegacy procedure commands and `ultrawork` are migration-only through 2026-09-30.\n",
    }


def _write_if_changed(path: Path, text: str) -> str:
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return "unchanged"
    path.parent.mkdir(parents=True, exist_ok=True)
    action = "updated" if path.exists() else "created"
    path.write_text(text, encoding="utf-8")
    return action


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _word_count(path: Path) -> int:
    return len(_read_text(path).split())
