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
