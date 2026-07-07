"""Fail closed when an agent creates malformed declared output artifacts."""

from __future__ import annotations

from pathlib import Path


_TEXT_OUTPUT_SUFFIXES = {".md", ".json", ".txt", ".yaml", ".yml", ".toml"}


def apply_agent_output_contract_patch() -> None:
    """Extend existence checks with deterministic output shape validation."""

    import harness_codex.runtime.runner as runner

    original_validate = runner._validate_agent_outputs
    if getattr(original_validate, "_agent_output_contract_patch", False):
        return

    def validate_agent_outputs(step, context):
        error = original_validate(step, context)
        if error:
            return error
        return _validate_declared_output_shapes(step, context.repo_root)

    validate_agent_outputs._agent_output_contract_patch = True
    runner._validate_agent_outputs = validate_agent_outputs


def _validate_declared_output_shapes(step, repo_root: Path) -> str | None:
    for relative in step.outputs:
        path = repo_root / relative
        if path.is_symlink():
            return f"agent output must not be a symlink: {relative}"
        if Path(relative).suffix and not path.is_file():
            return f"agent output must be a regular file: {relative}"
        if path.is_file() and Path(relative).suffix.lower() in _TEXT_OUTPUT_SUFFIXES:
            try:
                if path.stat().st_size == 0:
                    return f"agent output must not be empty: {relative}"
            except OSError:
                return f"agent output is unreadable: {relative}"
    return None
