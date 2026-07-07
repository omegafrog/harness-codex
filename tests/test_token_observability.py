from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.token_observability import collect_work_item_metrics


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
