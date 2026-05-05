import json
from pathlib import Path

from harness_codex.runtime import (
    ReportWriter,
    RunMode,
    RunReport,
    RunStatus,
    UseCaseReport,
)


def use_case_report(uc_id: str, status: RunStatus, blocker: str | None = None) -> UseCaseReport:
    return UseCaseReport(
        uc_id=uc_id,
        active_plan_path=Path(f"docs/plans/active/{uc_id}/plan.md"),
        completed_plan_path=(
            Path(f"docs/plans/completed/{uc_id}/plan.md")
            if status == RunStatus.SUCCEEDED
            else None
        ),
        e2e_goal_path=Path(f"docs/use-cases/{uc_id}/e2e-goal.md"),
        change_set_path=Path("docs/changes/active/CHG-001.md"),
        status=status,
        executor_status="succeeded" if status == RunStatus.SUCCEEDED else "stopped",
        verifier_status=status.value,
        commands_run=("./gradlew test", "./gradlew e2eTest"),
        test_gate_result="PASS" if status == RunStatus.SUCCEEDED else "FAIL",
        remediation_count=1 if status == RunStatus.FAILED else 0,
        blocker=blocker,
    )


def test_artifact_manifest_contains_run_and_use_case_paths(tmp_path: Path) -> None:
    writer = ReportWriter(tmp_path)

    manifest = writer.artifact_manifest("run-001", ("UC-001",))

    assert manifest.run_report_json == Path(".harness/runs/run-001/report.json")
    assert manifest.run_report_md == Path(".harness/runs/run-001/report.md")
    assert manifest.events_path == Path(".harness/runs/run-001/events.ndjson")
    assert manifest.use_case_artifacts["UC-001"]["executor_result"] == Path(
        ".harness/runs/run-001/use-cases/UC-001/executor-result.json"
    )
    assert manifest.use_case_artifacts["UC-001"]["blocker"] == Path(
        ".harness/runs/run-001/use-cases/UC-001/blocker.md"
    )


def test_report_writer_generates_run_json_and_markdown(tmp_path: Path) -> None:
    report = RunReport(
        run_id="run-001",
        change_set_id="CHG-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        status=RunStatus.SUCCEEDED,
        affected_use_cases=("UC-001",),
        completed_use_cases=("UC-001",),
        use_case_reports=(use_case_report("UC-001", RunStatus.SUCCEEDED),),
    )
    writer = ReportWriter(tmp_path)

    writer.write(report)

    run_json = json.loads(
        (tmp_path / ".harness/runs/run-001/report.json").read_text(
            encoding="utf-8"
        )
    )
    run_md = (tmp_path / ".harness/runs/run-001/report.md").read_text(
        encoding="utf-8"
    )

    assert run_json["run_id"] == "run-001"
    assert run_json["completed_use_cases"] == ["UC-001"]
    assert "Status: succeeded" in run_md


def test_report_writer_generates_failed_and_blocked_uc_reports(tmp_path: Path) -> None:
    report = RunReport(
        run_id="run-002",
        change_set_id="CHG-001",
        workflow_name="changeset-use-case-workflow",
        mode=RunMode.APPLY,
        status=RunStatus.BLOCKED,
        affected_use_cases=("UC-001", "UC-002"),
        failed_use_cases=("UC-001",),
        blocked_use_cases=("UC-002",),
        use_case_reports=(
            use_case_report("UC-001", RunStatus.FAILED),
            use_case_report("UC-002", RunStatus.BLOCKED, blocker="E2E goal unclear"),
        ),
    )
    writer = ReportWriter(tmp_path)

    writer.write(report)

    failed = json.loads(
        (
            tmp_path / ".harness/runs/run-002/use-cases/UC-001/report.json"
        ).read_text(encoding="utf-8")
    )
    blocker = (
        tmp_path / ".harness/runs/run-002/use-cases/UC-002/blocker.md"
    ).read_text(encoding="utf-8")

    assert failed["status"] == "failed"
    assert failed["remediation_count"] == 1
    assert "E2E goal unclear" in blocker
