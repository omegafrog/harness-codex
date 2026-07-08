from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.runner import BasicStepRunner


def test_local_reviewer_uses_ollama_and_writes_stdout_review(tmp_path: Path, monkeypatch) -> None:
    (tmp_path / ".codex/agents").mkdir(parents=True)
    (tmp_path / ".codex/agents/artifact_reviewer.toml").write_text(
        'provider = "codex"\nmodel = "gpt-5.5"\nlocal_model = "qwen3.5:9b"\n',
        encoding="utf-8",
    )
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(
        "\n".join(
            [
                "# 구현 계획",
                "## 패키지 및 의존성 계약",
                "- domain does not depend on ui.dto",
                "## 집중 검증",
                "- [ ] VERIFY-001: `true`",
            ]
        ),
        encoding="utf-8",
    )
    calls: list[list[str]] = []
    prompts: list[str] = []

    def fake_run(command, **kwargs):
        calls.append(list(command))
        if list(command)[:2] != ["ollama", "run"]:
            return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        prompts.append(str(kwargs.get("input") or ""))
        stdout = kwargs.get("stdout")
        output = "Thinking...\nReview Status: rejected\n\nReview Status: approved\n"
        if hasattr(stdout, "write"):
            stdout.write(output)
            stdout.flush()
        return type("Completed", (), {"returncode": 0, "stdout": output, "stderr": ""})()

    monkeypatch.setenv("HARNESS_LOCAL_REVIEWER", "1")
    monkeypatch.setattr("harness_codex.runtime.runner.subprocess.run", fake_run)

    context = RunContext(
        run_id="run-local",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-local",
        metadata={"active_work_item_id": "UC-001", "change_set_id": "CHG-001"},
    )
    step = Step(
        id="review-work-item-plan",
        kind=StepKind.AGENT,
        name="review",
        agent_id="artifact_reviewer",
        inputs=(Path("docs/plans/active/UC-001/plan.md"),),
        metadata={
            "review_gate": {
                "output": ".harness/runs/run-local/work-items/UC-001/reviews/plan-review.md",
                "status_label": "Review Status",
                "approved_status": "approved",
            }
        },
    )

    result = BasicStepRunner().run(step, context)

    assert result.status is StepStatus.SUCCEEDED
    assert ["ollama", "run", "qwen3.5:9b"] in calls
    assert prompts and prompts[0].startswith("/no_think\n")
    assert result.metadata["provider"] == "ollama"
    review = tmp_path / ".harness/runs/run-local/work-items/UC-001/reviews/plan-review.md"
    assert "Review Status: approved" in review.read_text(encoding="utf-8")
    assert "Thinking" not in review.read_text(encoding="utf-8")
