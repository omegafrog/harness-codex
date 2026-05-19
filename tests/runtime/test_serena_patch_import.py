import importlib


def test_serena_patch_wraps_current_provider_resolver() -> None:
    runtime = importlib.import_module("harness_codex.runtime")
    runner = importlib.import_module("harness_codex.runtime.runner")

    assert runtime is not None
    assert getattr(runner, "_harness_serena_mcp_patch_applied") is True
    assert hasattr(runner, "_harness_serena_mcp_original_provider_resolver")
    assert not hasattr(runner.CodexCliAgentAdapter, "_command")
