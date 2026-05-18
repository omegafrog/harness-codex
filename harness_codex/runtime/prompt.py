"""Deterministic prompt assembly for runtime agent invocations."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping

from harness_codex.runtime.models import RunContext, Step

STABLE_PREFIX_END_MARKER = "## 7. ChangeSet Summary"

RUNTIME_INSTRUCTION = """You are running as a harness-codex specialist agent.
Follow the repository source-of-truth files, the selected agent instruction, and the selected skill.
Keep edits inside the active ChangeSet and selected work item boundary.
Report changed files, verification commands, and blockers clearly."""

SOURCE_OF_TRUTH_FILES = (
    Path("AGENTS.md"),
    Path("docs/agent/context.md"),
    Path("docs/agent/commands.md"),
    Path("docs/agent/session-state.md"),
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

    Stable sections are emitted first so repeated calls can reuse provider prefix
    caches. Volatile run IDs, ChangeSet data, selected work item data, logs, and
    current payload are intentionally appended after the stable prefix marker.
    """

    sections = [
        _section("1. Runtime Instruction", RUNTIME_INSTRUCTION),
        _section("2. Repository Source of Truth", _source_of_truth(context.repo_root)),
        _section("3. Agent Instruction", _agent_instruction(agent_config, agent_config_path)),
        _section("4. Skill Body", _skill_body(skill_path, skill_body, context.repo_root)),
        _section("5. Workflow Definition", _workflow_definition(context)),
        _section("6. Repository Settings", _repository_settings(context.repo_root)),
        _section("7. ChangeSet Summary", _changeset_summary(context)),
        _section("8. Work Item Slice", _work_item_slice(context)),
        _section("9. Current Execution Payload", _current_execution_payload(step, context)),
    ]
    return "\n\n".join(sections).rstrip() + "\n"


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
        if absolute.exists():
            blocks.append(_file_block(path, absolute.read_text(encoding="utf-8")))
        else:
            blocks.append(_file_block(path, "<not found>"))
    return "\n\n".join(blocks)


def _file_block(path: Path, content: str) -> str:
    return "\n".join(
        [
            f"### `{path}`",
            "```text",
            content.strip(),
            "```",
        ]
    )


def _agent_instruction(agent_config: Mapping[str, Any], agent_config_path: Path) -> str:
    stable_agent_view = {
        "name": agent_config.get("name", ""),
        "description": agent_config.get("description", ""),
        "model": agent_config.get("model", ""),
        "model_reasoning_effort": agent_config.get("model_reasoning_effort", ""),
        "sandbox_mode": agent_config.get("sandbox_mode", ""),
        "provider": agent_config.get("provider", "codex"),
        "agent_config_path": str(agent_config_path),
    }
    developer_instructions = str(agent_config.get("developer_instructions", "")).strip()
    return "\n".join(
        [
            "```json",
            _stable_json(stable_agent_view),
            "```",
            "",
            "### Developer Instructions",
            developer_instructions or "<empty>",
        ]
    )


def _skill_body(
    skill_path: Path | None,
    skill_body: str | None,
    repo_root: Path,
) -> str:
    if skill_path is None:
        return "### Skill\n\n- Path: `<none>`\n- Body: `<none>`"

    try:
        display_path = skill_path.relative_to(repo_root)
    except ValueError:
        display_path = skill_path

    return "\n".join(
        [
            f"### `{display_path}`",
            "```markdown",
            (skill_body or "<empty>").strip(),
            "```",
        ]
    )


def _workflow_definition(context: RunContext) -> str:
    workflow_path = context.repo_root / ".harness/workflows" / f"{context.workflow_name}.yaml"
    if workflow_path.exists():
        return _file_block(
            Path(".harness/workflows") / f"{context.workflow_name}.yaml",
            workflow_path.read_text(encoding="utf-8"),
        )
    return _file_block(
        Path(".harness/workflows") / f"{context.workflow_name}.yaml",
        "<not found>",
    )


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
            "skill_id": step.skill_id,
            "command": step.command,
            "inputs": [str(path) for path in step.inputs],
            "outputs": [str(path) for path in step.outputs],
            "metadata": _jsonable(step.metadata),
        },
        "runtime_metadata": _jsonable(context.metadata),
    }
    return "\n".join(["```json", _stable_json(payload), "```"])


def _stable_json(value: Any) -> str:
    return json.dumps(_jsonable(value), ensure_ascii=False, indent=2, sort_keys=True)


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
