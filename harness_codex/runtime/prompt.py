"""Deterministic prompt assembly for runtime agent invocations."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.changeset_memory import render_stage_memory_context
from harness_codex.runtime.evolution import render_accepted_evolution_context
from harness_codex.runtime.models import RunContext, Step

STABLE_PREFIX_END_MARKER = "## 7. ChangeSet Summary"

RUNTIME_INSTRUCTION = """You are running as a harness-codex specialist agent.
Follow the repository source-of-truth files, the selected agent instruction, and the selected skill.
Keep edits inside the active ChangeSet and selected work item boundary.
Write all agent input/output and user-facing output in Korean.
Write human-readable Markdown output documents in Korean, including titles, headings, prose, table labels, statuses, findings, questions, recommended answers, and user-visible examples.
Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and previously approved canonical terms when compatibility requires their original form.
Report changed files, verification commands, and blockers clearly."""

TOKEN_EFFICIENT_CONTEXT_INSTRUCTION = """Token and repository-read budget:
- Treat runtime-declared inputs, handoff state, and selected slice artifacts as the primary context.
- Do not scan broad source trees, build files, Docker files, logs, or unrelated docs unless a declared input is missing evidence required for the current stage.
- When outside evidence is required, use targeted `rg -n` queries and small line windows instead of full-file dumps; summarize findings instead of pasting long content.
- Prefer stage handoff state, checksums, metadata rows, and existing artifact summaries over rereading complete upstream artifacts.
- Verification should emit compact pass/fail evidence and exact blocker paths, not full document bodies or command logs."""

EXECUTION_MINIMAL_INSTRUCTION = """You are running as the bounded implementation executor.
Treat the active plan as the sole product and implementation instruction. Read only the active plan and the runtime-owned execution-scope artifact before editing.
Execute unchecked plan tasks in order. Do not reinterpret requirements, use cases, event storming, E2E goals, ChangeSet documents, architecture, or technical decisions.
Keep edits inside the runtime-declared work-item boundary. Active-plan path lists are task guidance, not exhaustive write authority. Do not block solely because an in-scope source, test, build, or maintained script path is absent from a plan file list.
When the plan is insufficient, contradictory, or requires a wider design decision, report a blocker instead of reading upstream design artifacts.
For repeated reads of unchanged repo files, prefer `harness memory cache read PATH` after the first normal inspection; treat cached content as a read-through snapshot only, and refresh by reading the real file after edits.
Write all agent input/output and user-facing output in Korean. Preserve code identifiers, file paths, JSON keys, CLI commands, protocol names, and approved canonical terms when compatibility requires their original form.
Report changed files, focused verification commands, and blockers clearly."""

SOURCE_OF_TRUTH_FILES = (
    Path("AGENTS.md"),
    Path(".harness/docs/agent/context.md"),
    Path(".harness/docs/agent/commands.md"),
    Path(".harness/docs/agent/session-state.md"),
    Path(".harness/docs/agent/codebase-artifacts.md"),
    Path(".harness/docs/agent/design-conformance-report.md"),
)

REPOSITORY_SETTINGS_FILES = (
    Path(".codex/repository-settings.md"),
    Path(".codex/stack-profile.yaml"),
)


def build_agent_prompt(
    *,
    step: Step,
    context: RunContext,
    agent_config: Mapping[str, Any],
    agent_config_path: Path,
    skill_path: Path | None = None,
    skill_body: str | None = None,
) -> str:
    """Build one deterministic agent prompt.

    Long-term memory and accepted evolution guidance are deliberately volatile
    context: they are appended after authoritative source-of-truth sections and
    rendered as historical reference, never as executable instruction.
    """

    profile = _prompt_context_profile(step)
    if profile == "execution-minimal":
        sections = _execution_minimal_sections(
            step=step,
            context=context,
            agent_config=agent_config,
            agent_config_path=agent_config_path,
            skill_path=skill_path,
        )
        sections.append(
            _section(
                "4. Historical Memory and Evolution Context",
                _historical_reference_context(step, context),
            )
        )
        repair_context = _runtime_repair_context(step, context)
        if repair_context:
            sections.append(_section("5. Runtime Repair Context", repair_context))
        return "\n\n".join(sections).rstrip() + "\n"

    sections = [
        _section("1. Runtime Instruction", RUNTIME_INSTRUCTION),
        _section("2. Token-Efficient Context Policy", TOKEN_EFFICIENT_CONTEXT_INSTRUCTION),
        _section("3. Repository Source of Truth", _source_of_truth(context.repo_root)),
        _section(
            "4. Delegation Contract",
            _delegation_contract(
                step,
                agent_config,
                agent_config_path,
                skill_path,
                context.repo_root,
            ),
        ),
        _section("5. Workflow Definition", _workflow_definition(context)),
        _section("6. Repository Settings", _repository_settings(context.repo_root)),
        _section("7. ChangeSet Summary", _changeset_summary(context)),
        _section("8. Work Item Slice", _work_item_slice(context)),
        _section("9. Retrieved Long-Term Memory", _retrieved_memory(step, context)),
        _section("10. Accepted Evolution Guidance", _retrieved_evolution(step, context)),
        _section("11. Current Execution Payload", _current_execution_payload(step, context)),
    ]
    repair_context = _runtime_repair_context(step, context)
    if repair_context:
        sections.append(_section("12. Runtime Repair Context", repair_context))
    return "\n\n".join(sections).rstrip() + "\n"


def _execution_minimal_sections(
    *,
    step: Step,
    context: RunContext,
    agent_config: Mapping[str, Any],
    agent_config_path: Path,
    skill_path: Path | None,
) -> list[str]:
    return [
        _section("1. Runtime Instruction", EXECUTION_MINIMAL_INSTRUCTION),
        _section(
            "2. Delegation Contract",
            _delegation_contract(
                step,
                agent_config,
                agent_config_path,
                skill_path,
                context.repo_root,
            ),
        ),
        _section("3. Active Plan and Execution Scope", _execution_minimal_payload(step, context)),
    ]


def _prompt_context_profile(step: Step) -> str:
    value = step.metadata.get("prompt_context_profile")
    return value.strip() if isinstance(value, str) and value.strip() else "default"


def stable_prefix(prompt: str) -> str:
    """Return the stable prefix before volatile ChangeSet/work-item sections."""

    return prompt.split(STABLE_PREFIX_END_MARKER, maxsplit=1)[0]


def _section(title: str, body: str) -> str:
    return f"## {title}\n\n{body.strip()}"


def _source_of_truth(repo_root: Path) -> str:
    return _fixed_file_block(repo_root, SOURCE_OF_TRUTH_FILES)


def _repository_settings(repo_root: Path) -> str:
    return _fixed_file_block(repo_root, REPOSITORY_SETTINGS_FILES)


def _fixed_file_block(repo_root: Path, paths: tuple[Path, ...]) -> str:
    blocks: list[str] = []
    for path in sorted(paths, key=lambda value: str(value)):
        absolute = repo_root / path
        content = absolute.read_text(encoding="utf-8") if absolute.exists() else "<not found>"
        blocks.append(_file_block(path, content, repo_root))
    return "\n\n".join(blocks)


def _file_block(path: Path, content: str, repo_root: Path) -> str:
    return _cached_context_block(path, content, "text", repo_root=repo_root)


def _delegation_contract(
    step: Step,
    agent_config: Mapping[str, Any],
    agent_config_path: Path,
    skill_path: Path | None,
    repo_root: Path,
) -> str:
    agent_view = {
        "name": agent_config.get("name", ""),
        "description": agent_config.get("description", ""),
        "model": agent_config.get("model", ""),
        "model_reasoning_effort": agent_config.get("model_reasoning_effort", ""),
        "sandbox_mode": agent_config.get("sandbox_mode", ""),
        "provider": agent_config.get("provider", "codex"),
        "agent_id": step.agent_id,
        "agent_config_path": _display_path(agent_config_path, repo_root),
        "skill_id": _prompt_skill_id(step),
        "skill_path": _display_path(skill_path, repo_root) if skill_path else None,
    }
    return "\n".join(
        [
            "Load the selected agent config first, then use the listed skill.",
            "Read referenced files only when they are needed for the current task.",
            "Do not rely on this runtime prompt as the full instruction source.",
            "Keep writes inside the declared workflow and work-item boundaries.",
            "",
            "```json",
            _stable_json(agent_view),
            "```",
        ]
    )


def _display_path(path: Path, repo_root: Path) -> str:
    if not path.is_absolute():
        return str(path)
    try:
        return str(path.relative_to(repo_root))
    except ValueError:
        return str(path)


def _workflow_definition(context: RunContext) -> str:
    workflow_path = context.repo_root / ".harness/workflows" / f"{context.workflow_name}.yaml"
    content = workflow_path.read_text(encoding="utf-8") if workflow_path.exists() else "<not found>"
    return _file_block(Path(".harness/workflows") / f"{context.workflow_name}.yaml", content, context.repo_root)


def _changeset_summary(context: RunContext) -> str:
    change_set_path_value = context.metadata.get("change_set_path")
    change_set_path = Path(str(change_set_path_value)) if change_set_path_value else None
    blocks = [
        "```json",
        _stable_json(
            {
                "change_set_id": context.metadata.get("change_set_id"),
                "change_set_path": str(change_set_path) if change_set_path else None,
            }
        ),
        "```",
    ]
    if change_set_path is not None:
        absolute = context.repo_root / change_set_path
        blocks.extend(
            [
                "",
                _file_block(
                    change_set_path,
                    absolute.read_text(encoding="utf-8") if absolute.exists() else "<not found>",
                    context.repo_root,
                ),
            ]
        )
    return "\n".join(blocks)


def _work_item_slice(context: RunContext) -> str:
    active_id = context.metadata.get("active_work_item_id")
    active_type = context.metadata.get("active_work_item_type")
    affected_items = context.metadata.get("affected_work_items", ())
    active_item = None
    if isinstance(affected_items, list):
        active_item = next(
            (
                item
                for item in affected_items
                if isinstance(item, dict) and item.get("id") == active_id
            ),
            None,
        )
    return "\n".join(
        [
            "```json",
            _stable_json(
                {
                    "active_work_item_id": active_id,
                    "active_work_item_type": active_type,
                    "active_work_item": active_item,
                }
            ),
            "```",
        ]
    )


def _retrieved_memory(step: Step, context: RunContext) -> str:
    return render_stage_memory_context(
        repo_root=context.repo_root,
        step_id=step.id,
        change_set_id=_optional_text(context.metadata.get("change_set_id")),
        work_item_id=_optional_text(context.metadata.get("active_work_item_id")),
        work_item_type=_optional_text(context.metadata.get("active_work_item_type")),
    )


def _retrieved_evolution(step: Step, context: RunContext) -> str:
    return render_accepted_evolution_context(
        context.repo_root,
        step_id=step.id,
    )


def _historical_reference_context(step: Step, context: RunContext) -> str:
    return "\n\n".join(
        [
            "Active plan and execution-scope remain the only executable implementation instructions.",
            "Use the following context only to avoid repeating known workflow mistakes.",
            "",
            "### Long-Term Memory",
            _retrieved_memory(step, context),
            "",
            "### Accepted Evolution Guidance",
            _retrieved_evolution(step, context),
        ]
    )


def _optional_text(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _execution_minimal_payload(step: Step, context: RunContext) -> str:
    payload = {
        "run_id": context.run_id,
        "work_item_id": context.metadata.get("active_work_item_id"),
        "step": {
            "id": step.id,
            "agent_id": step.agent_id,
            "inputs": [str(path) for path in step.inputs],
            "outputs": [str(path) for path in step.outputs],
        },
        "required_reads": [str(path) for path in step.inputs],
        "explicitly_excluded_context": [
            "ChangeSet body",
            "workflow definition",
            "repository source-of-truth previews",
            "repository settings",
            "use-case, event-storming, and E2E-goal artifacts",
        ],
        "reference_only_context": [
            "verified long-term memory",
            "accepted evolution guidance",
        ],
        "read_cache_commands": [
            "harness memory cache read PATH",
            "harness memory cache warm PATH...",
            "harness memory cache stats",
            "harness memory cache clear",
        ],
    }
    return "\n".join(["```json", _stable_json(payload), "```"])


def _current_execution_payload(step: Step, context: RunContext) -> str:
    payload = {
        "run_id": context.run_id,
        "workflow_name": context.workflow_name,
        "mode": context.mode.value,
        "repo_root": str(context.repo_root),
        "workdir": str(context.workdir),
        "run_dir": str(context.run_dir),
        "step": {
            "id": step.id,
            "kind": step.kind.value,
            "name": step.name,
            "agent_id": step.agent_id,
            "skill_id": _prompt_skill_id(step),
            "command": step.command,
            "inputs": [str(path) for path in step.inputs],
            "outputs": [str(path) for path in step.outputs],
            "metadata": _prompt_jsonable(step.metadata),
        },
        "runtime_metadata": _prompt_jsonable(context.metadata),
    }
    return "\n".join(["```json", _stable_json(payload), "```"])


def _runtime_repair_context(step: Step, context: RunContext) -> str:
    """Return repair instructions only for a retried implementation executor."""

    if step.agent_id != "implementation_executor":
        return ""
    retry_count = context.metadata.get("runtime_retry_count")
    try:
        if int(retry_count) <= 0:
            return ""
    except (TypeError, ValueError):
        return ""
    work_item_id = _optional_text(context.metadata.get("active_work_item_id"))
    if work_item_id is None:
        return ""
    brief_path = (
        context.repo_root
        / ".harness"
        / "runs"
        / context.run_id
        / "work-items"
        / work_item_id
        / "verification"
        / "repair-brief.json"
    )
    if not brief_path.is_file():
        return ""
    relative_path = _display_path(brief_path, context.repo_root)
    return "\n".join(
        [
            "This is a verification-driven repair attempt for the active Work Item.",
            "",
            f"Read `{relative_path}` before editing.",
            "",
            "Required behavior:",
            "1. Fix only the unmet obligation and failed verification recorded in the repair brief.",
            "2. Run the failed verification commands first.",
            "3. After focused verification passes, run every applicable required verification gate.",
            "4. Do not weaken tests, acceptance criteria, scope boundaries, or verification goals.",
            "5. Report a blocker instead of changing the ChangeSet or design when the repair needs a wider decision.",
        ]
    )


def _stable_json(value: Any) -> str:
    return json.dumps(_jsonable(value), ensure_ascii=False, indent=2, sort_keys=True)


def _prompt_skill_id(step: Step) -> str | None:
    if step.skill_id:
        return step.skill_id
    value = step.metadata.get("skill_id")
    if isinstance(value, str) and value.strip():
        return value
    return None


def _cached_context_block(
    source_path: Path,
    content: str,
    language: str,
    *,
    repo_root: Path | None = None,
) -> str:
    normalized = content.strip()
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    cache_path = Path(".harness/cache/prompt-context") / f"{digest}.md"
    if repo_root is not None:
        absolute_cache_path = repo_root / cache_path
        absolute_cache_path.parent.mkdir(parents=True, exist_ok=True)
        if not absolute_cache_path.exists():
            absolute_cache_path.write_text(
                "\n".join(
                    [
                        f"# Prompt Context Cache {digest}",
                        "",
                        f"- Source: `{source_path}`",
                        f"- Language: `{language}`",
                        f"- Bytes: {len(normalized.encode('utf-8'))}",
                        "",
                        f"```{language}",
                        normalized,
                        "```",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
    return "\n".join(
        [
            f"### `{source_path}`",
            f"- Cache: `{cache_path}`",
            f"- SHA-256: `{digest}`",
            f"- Bytes: {len(normalized.encode('utf-8'))}",
            "- Instruction: read the cache file if this context is needed.",
            "",
            "Preview:",
            "```text",
            _preview(normalized),
            "```",
        ]
    )


def _preview(content: str, max_chars: int = 1000) -> str:
    if len(content) <= max_chars:
        return content
    return content[:max_chars].rstrip() + "\n..."


def _jsonable(value: Any) -> Any:
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, tuple):
        return [_jsonable(item) for item in value]
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if hasattr(value, "value"):
        return value.value
    return value


def _prompt_jsonable(value: Any, *, depth: int = 0) -> Any:
    if depth > 4:
        return _compact_scalar(value)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, tuple):
        return [_prompt_jsonable(item, depth=depth + 1) for item in value[:20]]
    if isinstance(value, list):
        items = [_prompt_jsonable(item, depth=depth + 1) for item in value[:20]]
        if len(value) > 20:
            items.append({"truncated_items": len(value) - 20})
        return items
    if isinstance(value, dict):
        result: dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 40:
                result["truncated_keys"] = len(value) - 40
                break
            result[str(key)] = _prompt_jsonable(item, depth=depth + 1)
        return result
    if isinstance(value, str):
        return _compact_text(value)
    if hasattr(value, "value"):
        return value.value
    return value


def _compact_scalar(value: Any) -> str:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return _compact_text(str(value))
    if isinstance(value, Path):
        return str(value)
    return f"<{type(value).__name__}>"


def _compact_text(value: str, max_chars: int = 500) -> str:
    if len(value) <= max_chars:
        return value
    return value[:max_chars].rstrip() + f"... <truncated {len(value) - max_chars} chars>"
