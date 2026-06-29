from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind
from harness_codex.runtime.prompt import build_agent_prompt


def _context(tmp_path: Path, *, retry_count: int = 1) -> RunContext:
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
            "runtime_retry_count": retry_count,
        },
    )


def _write_repair_brief(tmp_path: Path) -> Path:
    brief = tmp_path / ".harness/runs/run-1/work-items/UC-001/verification/repair-brief.json"
    brief.parent.mkdir(parents=True)
    brief.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "repair_attempt": 1,
                "failure": {
                    "fingerprint": "fingerprint-123",
                    "failed_gates": ["test-gate"],
                    "unmet_obligations": ["expired token must be rejected"],
                },
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return brief


def _executor_step() -> Step:
    return Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="execute",
        agent_id="implementation_executor",
    )


def test_retried_executor_prompt_reads_repair_brief_through_normal_path(tmp_path: Path) -> None:
    _write_repair_brief(tmp_path)

    prompt = build_agent_prompt(
        step=_executor_step(),
        context=_context(tmp_path),
        agent_config={},
        agent_config_path=Path(".codex/agents/implementation_executor.toml"),
    )

    assert "Runtime Repair Context" in prompt
    assert ".harness/runs/run-1/work-items/UC-001/verification/repair-brief.json" in prompt
    assert "Run the failed verification commands first." in prompt
    assert "Do not weaken tests, acceptance criteria, scope boundaries, or verification goals." in prompt


def test_initial_executor_prompt_does_not_receive_repair_context(tmp_path: Path) -> None:
    _write_repair_brief(tmp_path)

    prompt = build_agent_prompt(
        step=_executor_step(),
        context=_context(tmp_path, retry_count=0),
        agent_config={},
        agent_config_path=Path(".codex/agents/implementation_executor.toml"),
    )

    assert "Runtime Repair Context" not in prompt
