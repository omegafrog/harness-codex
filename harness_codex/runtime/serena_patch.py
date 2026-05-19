"""Runtime hook that wires Serena MCP into Codex agent invocations."""

from __future__ import annotations

import json

import harness_codex.runtime.runner as runner
from harness_codex.runtime.serena_mcp import SerenaMcpInstallation, ensure_serena_mcp

_PATCHED_ATTR = "_harness_serena_mcp_patch_applied"
_ORIGINAL_COMMAND_ATTR = "_harness_serena_mcp_original_command"


def apply_serena_mcp_patch() -> None:
    """Patch CodexCliAgentAdapter so supported projects get Serena MCP."""

    adapter_cls = runner.CodexCliAgentAdapter
    if getattr(adapter_cls, _PATCHED_ATTR, False):
        return

    original_command = adapter_cls._command
    setattr(adapter_cls, _ORIGINAL_COMMAND_ATTR, original_command)

    def command_with_serena_mcp(self, request, final_message_path):
        command = original_command(self, request, final_message_path)
        installation = ensure_serena_mcp(
            request.context.repo_root,
            request.context.workdir,
            request.step_dir,
        )
        _write_serena_manifest(request.step_dir, installation)
        if not installation.enabled:
            return command

        insertion_index = len(command) - 1 if command and command[-1] == "-" else len(command)
        for config_override in installation.codex_config_overrides:
            command[insertion_index:insertion_index] = ["-c", config_override]
            insertion_index += 2
        return command

    adapter_cls._command = command_with_serena_mcp
    setattr(adapter_cls, _PATCHED_ATTR, True)


def _write_serena_manifest(step_dir, installation: SerenaMcpInstallation) -> None:
    step_dir.mkdir(parents=True, exist_ok=True)
    (step_dir / "serena-mcp.json").write_text(
        json.dumps(installation.as_metadata(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
