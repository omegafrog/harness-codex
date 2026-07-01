import json
from pathlib import Path

from harness_codex.runtime.verify_work_item import verify_work_item
from harness_codex.runtime.workflows import load_named_workflow


def test_verify_work_item_workflow_uses_product_verifier_command() -> None:
    workflow = load_named_workflow("changeset-use-case-workflow")

    verification = workflow.step_by_id("verify-work-item")

    assert verification.command is not None
    assert "harness_codex.runtime.structured_verify_work_item" in verification.command
    assert "tests/runtime" not in verification.command
    assert (
        Path(".harness/runs/<RUN-ID>/work-items/<WORK-ITEM-ID>/verification/report.json")
        in verification.outputs
    )


def test_work_item_verifier_fails_when_plan_claims_complete_without_command_evidence(
    tmp_path: Path,
) -> None:
    _write_work_item_files(
        tmp_path,
        plan="- [x] Build: completed by executor\n",
        goal="|Step|Command|Success|Required|\n|---|---|---|---|\n",
    )

    result = verify_work_item(
        tmp_path,
        change_set_id="CHG-1",
        work_item_id="UC-1",
        run_id="run-001",
    )

    assert result.passed is False
    assert result.missing_obligations == ("build: Build: completed by executor",)
    report = json.loads(
        (
            tmp_path
            / ".harness/runs/run-001/work-items/UC-1/verification/report.json"
        ).read_text(encoding="utf-8")
    )
    assert report["status"] == "FAIL"
    assert report["commands"] == []


def test_work_item_verifier_runs_product_command_and_writes_structured_evidence(
    tmp_path: Path,
) -> None:
    _write_work_item_files(
        tmp_path,
        plan="- [x] Tests: `python3 -c \"print('plan-ok')\"`\n",
        goal=(
            "|Step|Command|Success|Required|\n"
            "|---|---|---|---|\n"
            "|E2E|`python3 -c \"print('goal-ok')\"`|exit code 0|required|\n"
        ),
    )

    result = verify_work_item(
        tmp_path,
        change_set_id="CHG-1",
        work_item_id="UC-1",
        run_id="run-001",
    )

    assert result.passed is True
    assert [command.command for command in result.command_results] == [
        "python3 -c \"print('plan-ok')\"",
        "python3 -c \"print('goal-ok')\"",
    ]
    report_path = tmp_path / result.evidence_dir / "report.json"
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert report["status"] == "PASS"
    assert len(report["commands"]) == 2


def test_work_item_verifier_reads_plan_verification_sections_only(
    tmp_path: Path,
) -> None:
    _write_work_item_files(
        tmp_path,
        plan=(
            "## 작업 체크리스트\n"
            "- [x] src/BuildService.java: build state projection\n"
            "- [x] src/OrderTest.java: focused test fixture\n"
            "\n"
            "## 집중 검증\n"
            "- [x] Focused tests: `python3 -c \"print('plan-ok')\"`\n"
        ),
        goal="|Step|Command|Success|Required|\n|---|---|---|---|\n",
    )

    result = verify_work_item(
        tmp_path,
        change_set_id="CHG-1",
        work_item_id="UC-1",
        run_id="run-001",
    )

    assert result.passed is True
    assert result.missing_obligations == ()
    assert [command.command for command in result.command_results] == [
        "python3 -c \"print('plan-ok')\"",
    ]


def test_work_item_verifier_does_not_execute_unchecked_or_placeholder_plan_commands(
    tmp_path: Path,
) -> None:
    _write_work_item_files(
        tmp_path,
        plan=(
            "## 집중 검증\n"
            "- [ ] Build: `python3 -c \"raise SystemExit(99)\"`\n"
            "- [x] E2E: `curl http://127.0.0.1/orders/<OWNED_ID>`\n"
            "- [x] Focused tests: `python3 -c \"print('plan-ok')\"`\n"
        ),
        goal="|Step|Command|Success|Required|\n|---|---|---|---|\n",
    )

    result = verify_work_item(
        tmp_path,
        change_set_id="CHG-1",
        work_item_id="UC-1",
        run_id="run-001",
    )

    assert result.passed is False
    assert result.missing_obligations == (
        "e2e: E2E: `curl http://127.0.0.1/orders/<OWNED_ID>`",
    )
    assert result.command_results == ()


def test_work_item_verifier_accepts_current_completed_execution_report_before_stale_plan_results(
    tmp_path: Path,
) -> None:
    _write_work_item_files(
        tmp_path,
        plan=(
            "## 집중 검증\n"
            "- [x] VERIFY-006 Runtime server verification: N/A - Docker CLI/daemon 접근이 없어 실행할 수 없다.\n"
        ),
        goal="|Step|Command|Success|Required|\n|---|---|---|---|\n",
    )
    evidence_dir = tmp_path / ".harness/runs/run-001/work-items/UC-1/steps/execute-work-item/evidence"
    evidence_dir.mkdir(parents=True)
    for name in ("build", "tests", "e2e", "test-gate", "runtime", "static-analysis"):
        evidence_dir.joinpath(f"{name}.txt").write_text("PASS\n", encoding="utf-8")
    report_path = tmp_path / ".harness/runs/run-001/work-items/UC-1/execution-report.json"
    report_path.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "change_set_id": "CHG-1",
                "work_item_id": "UC-1",
                "plan_path": "docs/plans/active/UC-1/plan.md",
                "status": "completed",
                "remaining_tasks": [],
                "blockers": [],
                "verification": [
                    {
                        "label": "Build",
                        "status": "PASS",
                        "evidence_path": ".harness/runs/run-001/work-items/UC-1/steps/execute-work-item/evidence/build.txt",
                    },
                    {
                        "label": "Tests",
                        "status": "PASS",
                        "evidence_path": ".harness/runs/run-001/work-items/UC-1/steps/execute-work-item/evidence/tests.txt",
                    },
                    {
                        "label": "E2E 또는 maintenance verification",
                        "status": "PASS",
                        "evidence_path": ".harness/runs/run-001/work-items/UC-1/steps/execute-work-item/evidence/e2e.txt",
                    },
                    {
                        "label": "Test gate",
                        "status": "PASS",
                        "evidence_path": ".harness/runs/run-001/work-items/UC-1/steps/execute-work-item/evidence/test-gate.txt",
                    },
                    {
                        "label": "Runtime server verification",
                        "status": "PASS",
                        "evidence_path": ".harness/runs/run-001/work-items/UC-1/steps/execute-work-item/evidence/runtime.txt",
                    },
                    {
                        "label": "Static analysis",
                        "status": "PASS",
                        "evidence_path": ".harness/runs/run-001/work-items/UC-1/steps/execute-work-item/evidence/static-analysis.txt",
                    },
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    result = verify_work_item(
        tmp_path,
        change_set_id="CHG-1",
        work_item_id="UC-1",
        run_id="run-001",
    )

    assert result.passed is True
    assert result.command_results == ()
    assert result.missing_obligations == ()
    report = json.loads(
        (
            tmp_path
            / ".harness/runs/run-001/work-items/UC-1/verification/report.json"
        ).read_text(encoding="utf-8")
    )
    assert report["status"] == "PASS"
    assert report["document_evidence"][0].startswith("execution-report: Build:")


def test_work_item_verifier_runs_test_gate_when_plan_and_goal_reference_gate(
    tmp_path: Path,
) -> None:
    _write_work_item_files(
        tmp_path,
        plan="- [x] Tests: `.codex/test-gate.yaml`\n",
        goal="|Step|Command|Success|Required|\n|Test gate|`.codex/test-gate.yaml`|PASS|required|\n",
    )
    gate_dir = tmp_path / ".codex"
    gate_dir.mkdir(exist_ok=True)
    (gate_dir / "test-gate.yaml").write_text(
        "required:\n"
        "  - name: unit\n"
        "    command: python3 -c \"print('gate-ok')\"\n",
        encoding="utf-8",
    )

    result = verify_work_item(
        tmp_path,
        change_set_id="CHG-1",
        work_item_id="UC-1",
        run_id="run-001",
    )

    assert result.passed is True
    assert [command.command for command in result.command_results] == [
        "python3 -c \"print('gate-ok')\"",
    ]


def test_work_item_verifier_reuses_matching_pass_evidence_but_reruns_test_gate(
    tmp_path: Path,
) -> None:
    plan_counter = tmp_path / "plan-count.txt"
    gate_counter = tmp_path / "gate-count.txt"
    plan_command = (
        "python3 -c \"from pathlib import Path; "
        f"p=Path('{plan_counter}'); p.write_text(str(int(p.read_text())+1) "
        "if p.exists() else '1')\""
    )
    gate_command = (
        "python3 -c \"from pathlib import Path; "
        f"p=Path('{gate_counter}'); p.write_text(str(int(p.read_text())+1) "
        "if p.exists() else '1')\""
    )
    _write_work_item_files(
        tmp_path,
        plan=(
            f"- [x] Tests: `{plan_command}`\n"
            "- [x] Test gate: `.codex/test-gate.yaml`\n"
        ),
        goal="|Step|Command|Success|Required|\n|---|---|---|---|\n",
    )
    gate_dir = tmp_path / ".codex"
    gate_dir.mkdir(exist_ok=True)
    gate_dir.joinpath("test-gate.yaml").write_text(
        f"required:\n  - name: unit\n    command: {gate_command}\n",
        encoding="utf-8",
    )

    first = verify_work_item(
        tmp_path,
        change_set_id="CHG-1",
        work_item_id="UC-1",
        run_id="run-001",
    )
    second = verify_work_item(
        tmp_path,
        change_set_id="CHG-1",
        work_item_id="UC-1",
        run_id="run-002",
    )

    assert first.passed is True
    assert second.passed is True
    assert plan_counter.read_text(encoding="utf-8") == "1"
    assert gate_counter.read_text(encoding="utf-8") == "2"
    assert [result.reused for result in second.command_results] == [True, False]

    forced = verify_work_item(
        tmp_path,
        change_set_id="CHG-1",
        work_item_id="UC-1",
        run_id="run-003",
        force_verification=True,
    )

    assert forced.passed is True
    assert plan_counter.read_text(encoding="utf-8") == "2"
    assert gate_counter.read_text(encoding="utf-8") == "3"
    assert all(not result.reused for result in forced.command_results)


def _write_work_item_files(tmp_path: Path, *, plan: str, goal: str) -> None:
    plan_dir = tmp_path / "docs/plans/active/UC-1"
    goal_dir = tmp_path / "docs/use-cases/UC-1"
    plan_dir.mkdir(parents=True)
    goal_dir.mkdir(parents=True)
    plan_dir.joinpath("plan.md").write_text(plan, encoding="utf-8")
    goal_dir.joinpath("e2e-goal.md").write_text(goal, encoding="utf-8")
