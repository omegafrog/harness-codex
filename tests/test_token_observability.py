from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.token_observability import (
    _compact_provider_usage,
    collect_work_item_metrics,
    execution_fingerprint,
    prompt_metrics,
)


def test_collects_provider_usage_from_compacted_result_metadata(tmp_path: Path) -> None:
    step_dir = tmp_path / ".harness/runs/run-1/steps/implementation"
    step_dir.mkdir(parents=True)
    (step_dir / "prompt.md").write_text("## Prompt\nbody\n", encoding="utf-8")
    (step_dir / "invocation.json").write_text(
        json.dumps({"step_id": "implementation", "agent_id": "implementation_executor"}),
        encoding="utf-8",
    )
    (step_dir / "result.json").write_text(
        json.dumps(
            {
                "status": "succeeded",
                "metadata": {
                    "usage": {
                        "input_tokens": 10,
                        "output_tokens": 5,
                        "reasoning_tokens": 3,
                        "total_tokens": 18,
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    metrics = collect_work_item_metrics(
        repo_root=tmp_path,
        run_id="run-1",
        work_item_id="UC-1",
    )

    step = metrics["steps"][0]
    assert step["usage_source"] == "provider"
    assert step["input_tokens"] == 10
    assert step["output_tokens"] == 5
    assert step["total_tokens"] == 18


def test_compact_provider_usage_reads_result_metadata() -> None:
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


def test_prompt_metrics_separates_stable_prefix() -> None:
    metrics = prompt_metrics("## 1. Runtime Instruction\nfixed\n## 7. ChangeSet Summary\ndynamic\n")

    assert metrics["total_chars"] > metrics["stable_prefix_chars"]
    assert metrics["stable_prefix_estimated_tokens"] < metrics["estimated_tokens"]
    assert len(metrics["stable_prefix_sha256"]) == 64


def test_execution_fingerprint_changes_when_model_or_prompt_changes() -> None:
    base = execution_fingerprint(
        prompt="prompt",
        command=["codex", "exec", "--model", "gpt-5.4"],
        provider="codex",
    )

    assert base != execution_fingerprint(
        prompt="changed",
        command=["codex", "exec", "--model", "gpt-5.4"],
        provider="codex",
    )
    assert base != execution_fingerprint(
        prompt="prompt",
        command=["codex", "exec", "--model", "gpt-5.5"],
        provider="codex",
    )


def test_metrics_preserve_attempt_and_provider_model_metadata(tmp_path: Path) -> None:
    step_dir = tmp_path / ".harness/runs/run-2/steps/execute"
    step_dir.mkdir(parents=True)
    (step_dir / "prompt.md").write_text("## Prompt\nbody\n", encoding="utf-8")
    (step_dir / "invocation.json").write_text(
        json.dumps({"step_id": "execute", "agent_id": "implementation_executor"}),
        encoding="utf-8",
    )
    (step_dir / "result.json").write_text(
        json.dumps(
            {
                "status": "failed",
                "metadata": {
                    "provider": "codex",
                    "model": "gpt-5.4",
                    "attempt": 2,
                    "provider_calls": 1,
                    "input_fingerprint": "abc",
                    "prompt_metrics": {"estimated_tokens": 12},
                },
            }
        ),
        encoding="utf-8",
    )

    metrics = collect_work_item_metrics(
        repo_root=tmp_path,
        run_id="run-2",
        work_item_id="MAINT-1",
    )

    step = metrics["steps"][0]
    assert step["model"] == "gpt-5.4"
    assert step["retry_count"] == 1
    assert step["input_fingerprint"] == "abc"
    assert metrics["retry_count"] == 1
