from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.models import RunContext, RunMode, Step, StepKind, StepStatus
from harness_codex.runtime.preflight import _plan_verification_tool_checks
from harness_codex.runtime.runner import BasicStepRunner
from harness_codex.runtime.structured_verify_work_item_xml import verify_and_classify_xml
from harness_codex.runtime.verification_failure import structured_failure_from_report
from harness_codex.runtime.xml_handoff import read_handoff, write_handoff


def _write_minimum_verification_docs(root: Path) -> None:
    (root / "docs/plans/active/UC-001").mkdir(parents=True)
    (root / "docs/use-cases/UC-001").mkdir(parents=True)
    (root / ".codex").mkdir()
    (root / "docs/plans/active/UC-001/plan.md").write_text(
        "\n".join(
            [
                "# 구현 계획",
                "## 집중 검증",
                "- [ ] VERIFY-001 Build: `./gradlew build`",
            ]
        ),
        encoding="utf-8",
    )
    (root / "docs/use-cases/UC-001/e2e-goal.md").write_text("# E2E\n", encoding="utf-8")
    (root / ".codex/test-gate.yaml").write_text("required: []\n", encoding="utf-8")


def test_verifier_writes_single_xml_with_execution_evidence(tmp_path: Path) -> None:
    _write_minimum_verification_docs(tmp_path)
    evidence = tmp_path / ".harness/runs/run-1/work-items/UC-001/steps/execute-work-item/evidence"
    evidence.mkdir(parents=True)
    (evidence / "build.txt").write_text("Status: FAIL\nmissing ehcache.xml\n", encoding="utf-8")
    (tmp_path / ".harness/runs/run-1/work-items/UC-001").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".harness/runs/run-1/work-items/UC-001/execution-report.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "change_set_id": "CHG-001",
                "work_item_id": "UC-001",
                "plan_path": "docs/plans/active/UC-001/plan.md",
                "status": "blocked",
                "verification": [
                    {
                        "label": "Build",
                        "status": "FAIL",
                        "evidence_path": ".harness/runs/run-1/work-items/UC-001/steps/execute-work-item/evidence/build.txt",
                    }
                ],
                "blockers": [{"type": "existing-build-test-failure", "detail": "missing ehcache.xml"}],
                "remaining_tasks": [],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    code = verify_and_classify_xml(
        tmp_path,
        change_set_id="CHG-001",
        work_item_id="UC-001",
        run_id="run-1",
    )

    assert code == 1
    verification_dir = tmp_path / ".harness/runs/run-1/work-items/UC-001/verification"
    assert not (verification_dir / "report.json").exists()
    assert not (verification_dir / "repair-brief.json").exists()
    payload = read_handoff(verification_dir / "verification.xml", expected_type="verification-report")
    assert payload["status"] == "FAIL"
    assert payload["failure_class"] == "environment_blocker"
    assert payload["verdict"]["status"] == "fail"
    assert payload["verdict"]["rule_id"] == "environment_blocker"
    assert payload["verdict"]["violations"][0]["type"] == "blocker"
    assert "owner_stage" not in payload
    assert "recommended_resume_target" not in payload
    assert "repair" not in payload
    assert payload["evidence_items"][0]["content"] == "Status: FAIL\nmissing ehcache.xml"


def test_structured_failure_rejects_old_routing_report_shape() -> None:
    failure = structured_failure_from_report(
        {
            "failure_class": "environment_blocker",
            "owner_stage": "environment",
            "recommended_resume_target": "environment",
            "evidence": ["tool unavailable"],
            "verdict": {
                "status": "fail",
                "rule_id": "environment_blocker",
                "reason": "tool unavailable",
                "evidence_path": ".harness/runs/run-old/work-items/UC-001/verification/verification.xml",
                "violations": [],
            },
        }
    )

    assert failure is None


def test_plan_preflight_checks_docker_from_verify_command(tmp_path: Path, monkeypatch) -> None:
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text(
        "- [ ] VERIFY-006 Runtime: `command -v docker && docker info >/dev/null && scripts/local-smoke.sh`\n",
        encoding="utf-8",
    )

    monkeypatch.setattr("harness_codex.runtime.preflight.subprocess.run", lambda *_, **__: type("R", (), {"returncode": 1, "stderr": "daemon down"})())

    checks = _plan_verification_tool_checks(tmp_path, (type("Scope", (), {"display_id": "UC-001"})(),))

    assert checks
    assert checks[0].check_id == "plan-required-tool-docker:UC-001"
    assert checks[0].status == "fail"
    assert checks[0].severity == "blocking"


def test_executor_blocks_repeated_nonimplementation_verification_failure(tmp_path: Path) -> None:
    _write_minimum_verification_docs(tmp_path)
    plan = tmp_path / "docs/plans/active/UC-001/plan.md"
    previous = tmp_path / ".harness/runs/run-old/work-items/UC-001/verification/verification.xml"
    write_handoff(
        previous,
        "verification-report",
        {
            "schema_version": 2,
            "change_set_id": "CHG-001",
            "work_item_id": "UC-001",
            "run_id": "run-old",
            "status": "FAIL",
            "plan_path": "docs/plans/active/UC-001/plan.md",
            "plan_sha256": __import__("hashlib").sha256(plan.read_bytes()).hexdigest(),
            "verification_goal_path": "docs/use-cases/UC-001/e2e-goal.md",
            "evidence_items": [],
            "failure_class": "environment_blocker",
            "failure_fingerprint": "abc",
            "verdict": {
                "status": "fail",
                "rule_id": "environment_blocker",
                "reason": "daemon down",
                "evidence_path": ".harness/runs/run-old/work-items/UC-001/verification/verification.xml",
                "violations": [],
            },
        },
    )
    (tmp_path / ".codex/agents").mkdir(parents=True)
    (tmp_path / ".codex/agents/implementation_executor.toml").write_text("model = \"test\"\n", encoding="utf-8")
    context = RunContext(
        run_id="run-new",
        workflow_name="workflow",
        mode=RunMode.APPLY,
        repo_root=tmp_path,
        workdir=tmp_path,
        run_dir=tmp_path / ".harness/runs/run-new",
        metadata={"active_work_item_id": "UC-001"},
    )
    step = Step(
        id="execute-work-item",
        kind=StepKind.AGENT,
        name="execute",
        agent_id="implementation_executor",
    )

    result = BasicStepRunner().run(step, context)

    assert result.status is StepStatus.BLOCKED
    assert "same unresolved verification failure already exists" in str(result.error)
