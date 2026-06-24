from __future__ import annotations

import json
from pathlib import Path

import harness_codex.runtime.runner as runner_module
from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.verification_routing_engine_patch import (
    apply_verification_routing_engine_patch,
)


def _context(tmp_path: Path) -> RunContext:
    return RunContext(
        run_id="run-1",
        workflow_name="changeset-work-item-workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-1/work-items/UC-001",
        metadata={
            "change_set_id": "CHG-20260624-001",
            "active_work_item_id": "UC-001",
            "active_work_item_type": "use_case",
            "active_plan_path": "docs/plans/active/UC-001/plan.md",
            "runtime_retry_count": 1,
            "runtime_failed_step_id": "verify-work-item",
            "runtime_failure_kind": "implementation",
            "runtime_failure_metadata": {"verification_report_path": ".harness/runs/run-1/work-items/UC-001/verification/report.json"},
        },
    )


def _write_failure_artifacts(tmp_path: Path) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("# Plan\n\n- [ ] Implement token rejection\n", encoding="utf-8")

    report = tmp_path / ".harness/runs/run-1/work-items/UC-001/verification/report.json"
    report.parent.mkdir(parents=True)
    report.write_text(
        json.dumps(
            {
                "failure_class": "implementation_failure",
                "failure_fingerprint": "fingerprint-123",
                "failed_gates": ["test-gate"],
                "failed_commands": [
                    {
                        "name": "auth tests",
                        "command": "python -m pytest tests/auth -q",
                        "source": ".codex/test-gate.yaml",
                        "exit_code": 1,
                        "stdout_path": "verification/command-01/stdout.txt",
                        "stderr_path": "verification/command-01/stderr.txt",
                    }
                ],
                "unmet_obligations": ["expired token must be rejected"],
                "evidence": ["failed command: python -m pytest tests/auth -q"],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def test_remediation_writes_repair_brief_plan_link_and_executor_prompt(tmp_path: Path) -> None:
    _write_failure_artifacts(tmp_path)
    apply_verification_routing_engine_patch()
    context = _context(tmp_path)
    remediation_step = Step(
        id="remediate-work-item",
        kind=StepKind.RECORD,
        name="remediate",
        outputs=(Path("docs/plans/active/UC-001/plan.md"),),
        metadata={"loop_target": "execute-work-item"},
    )

    result = runner_module.BasicStepRunner().run(remediation_step, context)

    assert result.status is StepStatus.SUCCEEDED
    brief_path = tmp_path / ".harness/runs/run-1/work-items/UC-001/verification/repair-brief.json"
    brief = json.loads(brief_path.read_text(encoding="utf-8"))
    assert brief["repair_attempt"] == 1
    assert brief["resume_target"] == "execute-work-item"
    assert brief["failure"]["fingerprint"] == "fingerprint-123"
    assert brief["failure"]["failed_gates"] == ["test-gate"]
    assert brief["verification_order"][0] == "Run every failed verification command first."

    plan_text = (tmp_path / "docs/plans/active/UC-001/plan.md").read_text(encoding="utf-8")
    assert "Runtime Remediation" in plan_text
    assert "Repair brief: `.harness/runs/run-1/work-items/UC-001/verification/repair-brief.json`" in plan_text
    assert "Re-verification order:" in plan_text

    execute_step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="execute",
        agent_id="implementation_executor",
    )
    prompt = runner_module.build_agent_prompt(
        step=execute_step,
        context=context,
        agent_config={},
        agent_config_path=Path(".codex/agents/implementation_executor.toml"),
    )

    assert "## Runtime Repair Context" in prompt
    assert "repair-brief.json" in prompt
    assert "Run the failed verification commands first." in prompt
