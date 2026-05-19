import importlib


def test_serena_patch_noops_when_adapter_has_no_legacy_command() -> None:
    runtime = importlib.import_module("harness_codex.runtime")
    runner = importlib.import_module("harness_codex.runtime.runner")

    assert runtime is not None
    assert getattr(runner.CodexCliAgentAdapter, "_harness_serena_mcp_patch_applied") is True
    assert not hasattr(runner.CodexCliAgentAdapter, "_command")
