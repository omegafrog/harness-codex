"""Deterministic, stage-scoped prompt assembly for runtime agent invocations."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.models import RunContext, Step

STABLE_PREFIX_END_MARKER = "## 6. ChangeSet Summary"

RUNTIME_INSTRUCTION = """You are running as a harness-codex specialist agent.
Read `AGENTS.md` first, then load only the stage-profile and runtime-declared files needed for this task.
Follow the selected agent instruction and skill. Keep edits inside the active ChangeSet and selected work-item boundary.
Report changed files, verification commands, and blockers clearly."""

_AGENT_CONTEXT = Path("AGENTS.md")
_CONTEXT_MAP = Path("docs/agent/context.md")
_COMMANDS = Path("docs/agent/commands.md")
_SESSION_STATE = Path("docs/agent/session-state.md")
PROMPT_CONTEXT_PROFILE_KEY = "prompt_context_profile"

CONTEXT_PROFILE_FILES: dict[str, tuple[Path, ...]] = {
    "plan": (_AGENT_CONTEXT, _CONTEXT_MAP, _COMMANDS),
    "security-review": (_AGENT_CONTEXT, _CONTEXT_MAP),
    "review": (_AGENT_CONTEXT,),
    "execution": (_AGENT_CONTEXT, _COMMANDS),
    "security-verification": (_AGENT_CONTEXT, _CONTEXT_MAP),
    "documentation": (_AGENT_CONTEXT, _CONTEXT_MAP, _COMMANDS),
}

REPOSITORY_SETTINGS_FILES = (
    Path(".codex/repository-settings.md"),
    Path(".codex/stack-profile.yaml"),
)

STEP_METADATA_ALLOWLIST = frozenset(
    {
        "stage",
        PROMPT_CONTEXT_PROFILE_KEY,
        "scope",
        "condition",
        "fail_closed",
        "baseline",
        "artifact_type",
        "review_gate",
        "test_gate",
        "run_on_final_work_item_only",
        "loop_target",
        "max_retry_count",
        "classifier",
    }
)

RUNTIME_METADATA_ALLOWLIST = frozenset(
    {
        "is_final_work_item",
        "skip_precompleted_work_item_steps",
        "force_verification",
        "resume_target",
        "resume_from_step",
        "include_session_state",
    }
)

WORK_ITEM_METADATA_ALLOWLIST = (
    "id",
    "type",
    "name",
    "slice_path",
    "verification_goal_path",
    "status",
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
    """Build one deterministic prompt with stage-scoped references only.

    Stable sections are emitted first so repeated calls can reuse provider prefix
    caches. Volatile run IDs, ChangeSet data, selected work-item data, and
    execution controls are appended after the stable prefix marker.
    """
    del skill_body  # The agent loads the selected skill from its repository path.
    sections = [
        _section("1. Runtime Instruction", RUNTIME_INSTRUCTION),
        _section("2. Repository Source of Truth", _source_of_truth(step, context)),
        _section(
            "3. Delegation Contract",
            _delegation_contract(
                step,
                agent_config,
                agent_config_path,
                skill_path,
                context.repo_root,
            ),
        ),
        _section("4. Workflow Definition", _workflow_definition(step, context)),
        _section("5. Repository Settings", _repository_settings(step, context.repo_root)),
        _section("6. ChangeSet Summary", _changeset_summary(context)),
        _section("7. Work Item Slice", _work_item_slice(context)),
        _section("8. Current Execution Payload", _current_execution_payload(step, context)),
    ]
    return "\n\n".join(sections).rstrip() + "\n"


def stable_prefix(prompt: str) -> str:
    """Return the stable prefix before volatile ChangeSet/work-item sections."""
    return prompt.split(STABLE_PREFIX_END_MARKER, maxsplit=1)[0]


def _section(title: str, body: str) -> str:
    return f"## {title}\n\n{body.strip()}"


def _stage(step: Step) -> str:
    return str(step.metadata.get("stage") or "").strip()


def _context_profile(step: Step) -> str:
    value = step.metadata.get(PROMPT_CONTEXT_PROFILE_KEY)
    if isinstance(value, str) and value.strip():
        return value.strip()
    return _stage(step)


def _source_of_truth(step: Step, context: RunContext) -> str:
    stage = _stage(step)
    profile = _context_profile(step)
    paths = list(CONTEXT_PROFILE_FILES.get(profile, (_AGENT_CONTEXT,)))
    if bool(context.metadata.get("include_session_state")):
        paths.append(_SESSION_STATE)

    references = _existing_context_references(context.repo_root, tuple(dict.fromkeys(paths)))
    lines = [
        f"Stage: `{stage or 'unspecified'}`.",
        f"Context profile: `{profile or 'default'}`.",
        "Use only the referenced source files needed to complete this step; do not broad-dump repository context.",
    ]
    if references:
        lines.extend(["", "Available source references:", references])
    else:
        lines.append("\nNo optional profile files are present.")
    return "\n".join(lines)


def _repository_settings(step: Step, repo_root: Path) -> str:
    declared = tuple(path for path in REPOSITORY_SETTINGS_FILES if path in step.inputs)
    references = _existing_context_references(repo_root, declared)
    return references or "No declared repository settings file is present."


def _existing_context_references(repo_root: Path, paths: tuple[Path, ...]) -> str:
    blocks: list[str] = []
    for path in sorted(set(paths), key=str):
        absolute = repo_root / path
        if absolute.is_file():
            blocks.append(_context_reference(path, absolute.read_text(encoding="utf-8"), repo_root))
    return "\n".join(blocks)


def _context_reference(source_path: Path, content: str, repo_root: Path) -> str:
    normalized = content.strip()
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
    cache_path = Path(".harness/cache/prompt-context") / f"{digest}.md"
    absolute_cache_path = repo_root / cache_path
    absolute_cache_path.parent.mkdir(parents=True, exist_ok=True)
    if not absolute_cache_path.exists():
        absolute_cache_path.write_text(
            "\n".join(
                [
                    f"# Prompt Context Cache {digest}",
                    "",
                    f"- Source: `{source_path}`",
                    f"- Bytes: {len(normalized.encode('utf-8'))}",
                    "",
                    "```text",
                    normalized,
                    "```",
                    "",
                ]
            ),
            encoding="utf-8",
        )
    return f"- `{source_path}` (Cache: `{cache_path}`, bytes: {len(normalized.encode('utf-8'))})"


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


def _workflow_definition(step: Step, context: RunContext) -> str:
    workflow_path = Path(".harness/workflows") / f"{context.workflow_name}.yaml"
    return "\n".join(
        [
            "Use the workflow file only when this stage definition is insufficient.",
            "```json",
            _stable_json(
                {
                    "workflow_name": context.workflow_name,
                    "workflow_path": str(workflow_path),
                    "stage": _stage(step),
                    "prompt_context_profile": _context_profile(step),
                    "scope": step.metadata.get("scope"),
                }
            ),
            "```",
        ]
    )


def _step_contract(step: Step) -> dict[str, Any]:
    return {
        "id": step.id,
        "kind": step.kind.value,
        "name": step.name,
        "agent_id": step.agent_id,
        "skill_id": _prompt_skill_id(step),
        "command": step.command,
        "inputs": [str(path) for path in step.inputs],
        "outputs": [str(path) for path in step.outputs],
        "metadata": {
            key: _jsonable(step.metadata[key])
            for key in sorted(STEP_METADATA_ALLOWLIST)
            if key in step.metadata
        },
    }


def _changeset_summary(context: RunContext) -> str:
    change_set_path_value = context.metadata.get("change_set_path")
    change_set_path = Path(str(change_set_path_value)) if change_set_path_value else None
    summary: dict[str, Any] = {
        "change_set_id": context.metadata.get("change_set_id"),
        "change_set_path": str(change_set_path) if change_set_path else None,
    }
    if change_set_path is not None and (context.repo_root / change_set_path).is_file():
        summary["change_set_reference"] = _context_reference(
            change_set_path,
            (context.repo_root / change_set_path).read_text(encoding="utf-8"),
            context.repo_root,
        )
    return "\n".join(["```json", _stable_json(summary), "```"])


def _work_item_slice(context: RunContext) -> str:
    active_id = context.metadata.get("active_work_item_id")
    active_type = context.metadata.get("active_work_item_type")
    active_item = _active_work_item(context.metadata.get("affected_work_items"), active_id)
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


def _active_work_item(affected_items: Any, active_id: Any) -> dict[str, Any] | None:
    if not isinstance(affected_items, list):
        return None
    for item in affected_items:
        if isinstance(item, dict) and item.get("id") == active_id:
            return {
                key: _jsonable(item[key])
                for key in WORK_ITEM_METADATA_ALLOWLIST
                if key in item
            }
    return None


def _current_execution_payload(step: Step, context: RunContext) -> str:
    payload = {
        "run_id": context.run_id,
        "workflow_name": context.workflow_name,
        "mode": context.mode.value,
        "repo_root": str(context.repo_root),
        "workdir": str(context.workdir),
        "run_dir": str(context.run_dir),
        "step": _step_contract(step),
        "runtime_controls": {
            key: _jsonable(context.metadata[key])
            for key in sorted(RUNTIME_METADATA_ALLOWLIST)
            if key in context.metadata
        },
    }
    return "\n".join(["```json", _stable_json(payload), "```"])


def _stable_json(value: Any) -> str:
    return json.dumps(_jsonable(value), ensure_ascii=False, indent=2, sort_keys=True)


def _prompt_skill_id(step: Step) -> str | None:
    if step.skill_id:
        return step.skill_id
    value = step.metadata.get("skill_id")
    if isinstance(value, str) and value.strip():
        return value
    return None


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
