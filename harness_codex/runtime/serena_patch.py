"""Runtime hook that wires required MCP servers into Codex agent invocations."""

from __future__ import annotations

import json

import harness_codex.runtime.runner as runner
from harness_codex.runtime.playwright_mcp import (
    PlaywrightMcpInstallation,
    browser_ui_candidate,
    ensure_playwright_mcp,
)
from harness_codex.runtime.serena_mcp import SerenaMcpInstallation, ensure_serena_mcp

_PATCHED_ATTR = "_harness_serena_mcp_patch_applied"
_ORIGINAL_RESOLVER_ATTR = "_harness_serena_mcp_original_provider_resolver"


def apply_serena_mcp_patch() -> None:
    """Patch provider command construction so Codex runs can use Serena MCP."""
    if getattr(runner, _PATCHED_ATTR, False):
        return
    original_resolver = getattr(runner, "_resolve_provider_command", None)
    if original_resolver is None:
        setattr(runner, _PATCHED_ATTR, True)
        return
    setattr(runner, _ORIGINAL_RESOLVER_ATTR, original_resolver)

    def resolve_provider_command_with_serena(request, final_message_path, *, default_codex_binary):
        provider_result = original_resolver(
            request,
            final_message_path,
            default_codex_binary=default_codex_binary,
        )
        if isinstance(provider_result, runner.AgentRunResult):
            return provider_result
        command, metadata = provider_result
        if metadata.get("provider") != "codex":
            return command, metadata
        command, serena_metadata = _inject_serena_mcp(request, command)
        command, playwright_metadata = _inject_playwright_mcp(request, command)
        return command, {
            **metadata,
            "provider_command": command,
            "serena_mcp": serena_metadata,
            "playwright_mcp": playwright_metadata,
        }

    runner._resolve_provider_command = resolve_provider_command_with_serena
    setattr(runner, _PATCHED_ATTR, True)


def _inject_serena_mcp(request, command: list[str]) -> tuple[list[str], dict]:
    installation = ensure_serena_mcp(
        request.context.repo_root,
        request.context.workdir,
        request.step_dir,
    )
    _write_serena_manifest(request.step_dir, installation)
    if not installation.enabled:
        return command, installation.as_metadata()
    patched_command = list(command)
    insertion_index = len(patched_command) - 1 if patched_command and patched_command[-1] == "-" else len(patched_command)
    for config_override in installation.codex_config_overrides:
        patched_command[insertion_index:insertion_index] = ["-c", config_override]
        insertion_index += 2
    return patched_command, installation.as_metadata()


def _write_serena_manifest(step_dir, installation: SerenaMcpInstallation) -> None:
    step_dir.mkdir(parents=True, exist_ok=True)
    (step_dir / "serena-mcp.json").write_text(
        json.dumps(installation.as_metadata(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _inject_playwright_mcp(request, command: list[str]) -> tuple[list[str], dict]:
    if request.step.agent_id != "implementation_executor":
        return command, {"enabled": False, "reason": "not an implementation_executor step"}
    if not browser_ui_candidate(request.context.repo_root, request.context.active_plan_path):
        return command, {"enabled": False, "reason": "no browser-eligible web UI verification target"}
    installation = ensure_playwright_mcp(
        request.context.workdir,
        request.step_dir,
    )
    _write_playwright_manifest(request.step_dir, installation)
    if not installation.enabled:
        return command, installation.as_metadata()
    patched_command = list(command)
    insertion_index = (
        len(patched_command) - 1
        if patched_command and patched_command[-1] == "-"
        else len(patched_command)
    )
    for config_override in installation.codex_config_overrides:
        patched_command[insertion_index:insertion_index] = ["-c", config_override]
        insertion_index += 2
    return patched_command, installation.as_metadata()


def _write_playwright_manifest(step_dir, installation: PlaywrightMcpInstallation) -> None:
    step_dir.mkdir(parents=True, exist_ok=True)
    (step_dir / "playwright-mcp.json").write_text(
        json.dumps(installation.as_metadata(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
