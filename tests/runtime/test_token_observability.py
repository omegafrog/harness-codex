import json
from pathlib import Path

from harness_codex.runtime.token_observability import collect_work_item_metrics, extract_codex_usage


def test_extract_codex_usage_normalizes_aliases() -> None:
    result = extract_codex_usage(json.dumps({"usage": {"prompt_tokens": 120, "cached_prompt_tokens": 20, "completion_tokens": 30, "reasoning_tokens": 50}}))
    assert result["found"] is True
    assert result["usage"] == {"input_tokens": 120, "cached_input_tokens": 20, "output_tokens": 30, "reasoning_tokens": 50, "total_tokens": 200}


def test_collect_metrics_writes_step_and_run_artifacts(tmp_path: Path) -> None:
    run_id, work_item = "run-001", "UC-001"
    step = tmp_path / ".harness/runs" / run_id / "steps/execute-work-item"
    step.mkdir(parents=True)
    (step / "prompt.md").write_text("## 1. Runtime Instruction\n\nexecutor\n\n## 2. Delegation Contract\n\n{}\n", encoding="utf-8")
    (step / "invocation.json").write_text(json.dumps({"step_id": "execute-work-item", "agent_id": "implementation_executor", "inputs": ["docs/plans/active/UC-001/plan.md"], "metadata": {"prompt_context_profile": "execution-minimal"}}), encoding="utf-8")
    (step / "result.json").write_text(json.dumps({"status": "succeeded", "metadata": {}}), encoding="utf-8")
    (step / "stdout.txt").write_text(json.dumps({"usage": {"input_tokens": 80, "output_tokens": 12}}) + "\n", encoding="utf-8")
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("# Plan\n", encoding="utf-8")

    metrics = collect_work_item_metrics(repo_root=tmp_path, run_id=run_id, work_item_id=work_item)

    usage = json.loads((step / "usage.json").read_text(encoding="utf-8"))
    resolved = json.loads((step / "resolved-inputs.json").read_text(encoding="utf-8"))
    assert usage["usage_source"] == "provider"
    assert usage["input_tokens"] == 80
    assert metrics["totals"]["output_tokens"] == 12
    assert resolved["inputs"][0]["path"] == "docs/plans/active/UC-001/plan.md"
    assert any(row["description"] == "ChangeSet body" for row in resolved["excluded_inputs"])
