from harness_codex.runtime.token_observability_trace_retention_patch import (
    _compact_provider_usage,
)


def test_compact_provider_usage_reads_trace_retention_metadata() -> None:
    result = {
        "metadata": {
            "trace_retention": "summary",
            "usage": {
                "input_tokens": 120,
                "cached_input_tokens": 20,
                "output_tokens": 30,
                "reasoning_tokens": 40,
            },
        }
    }

    assert _compact_provider_usage(result) == {
        "input_tokens": 120,
        "cached_input_tokens": 20,
        "output_tokens": 30,
        "reasoning_tokens": 40,
    }


def test_compact_provider_usage_ignores_missing_metadata() -> None:
    assert _compact_provider_usage({}) == {}
