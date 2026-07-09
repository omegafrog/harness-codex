from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.step_xml_contracts import (
    DiffEntry,
    ReadFrontierCandidate,
    RuntimeEvidence,
    TestGateResult,
    VerificationLevel,
    collect_diff_summary,
    verify_runtime_evidence,
)


def test_read_frontier_is_not_an_executor_read_or_write_gate() -> None:
    evidence = RuntimeEvidence(
        work_item_id="MAINT-001",
        work_item_type="maintenance",
        read_frontier=(
            ReadFrontierCandidate(
                path=Path("src/entry.py"),
                reason="failure starts here",
                profile="maintenance",
            ),
        ),
        diff_summary=(DiffEntry(path=Path("src/adapter.py"), action="modified"),),
        test_results=(TestGateResult(command="pytest tests/test_entry.py", status="passed"),),
    )

    result = verify_runtime_evidence(
        evidence=evidence,
        git_diff_paths=["src/adapter.py"],
    )

    assert not result.blocked
    assert result.findings == ()


def test_missing_diff_summary_entry_is_blocked() -> None:
    evidence = RuntimeEvidence(
        work_item_id="MAINT-001",
        work_item_type="maintenance",
        test_results=(TestGateResult(command="pytest", status="passed"),),
    )

    result = verify_runtime_evidence(
        evidence=evidence,
        git_diff_paths=["src/untracked-in-summary.py"],
    )

    assert result.blocked
    assert result.blockers[0].code == "DIFF_SUMMARY_MISSING_FILE"


def test_stale_diff_summary_entry_warns_only() -> None:
    evidence = RuntimeEvidence(
        work_item_id="MAINT-001",
        work_item_type="maintenance",
        diff_summary=(DiffEntry(path=Path("src/stale.py"), action="modified"),),
        test_results=(TestGateResult(command="pytest", status="passed"),),
    )

    result = verify_runtime_evidence(evidence=evidence, git_diff_paths=[])

    assert not result.blocked
    assert result.warnings[0].code == "DIFF_SUMMARY_STALE_FILE"


def test_required_test_gate_must_run_and_pass() -> None:
    evidence = RuntimeEvidence(
        work_item_id="MAINT-001",
        work_item_type="maintenance",
        diff_summary=(DiffEntry(path=Path("src/fix.py"), action="modified"),),
    )

    missing = verify_runtime_evidence(evidence=evidence, git_diff_paths=["src/fix.py"])

    assert missing.blocked
    assert missing.blockers[0].code == "TEST_GATE_NOT_RUN"

    failed = verify_runtime_evidence(
        evidence=RuntimeEvidence(
            work_item_id="MAINT-001",
            work_item_type="maintenance",
            diff_summary=(DiffEntry(path=Path("src/fix.py"), action="modified"),),
            test_results=(TestGateResult(command="pytest", status="failed"),),
        ),
        git_diff_paths=["src/fix.py"],
    )

    assert failed.blocked
    assert failed.blockers[0].code == "TEST_GATE_FAILED"


def test_collect_diff_summary_normalizes_name_status_entries() -> None:
    summary = collect_diff_summary(
        [
            ("src/fix.py", "modified"),
            (Path("tests/test_fix.py"), "created"),
        ]
    )

    assert summary == (
        DiffEntry(path=Path("src/fix.py"), action="modified"),
        DiffEntry(path=Path("tests/test_fix.py"), action="created"),
    )
    assert all(isinstance(entry.path, Path) for entry in summary)
    assert all(level.value for level in VerificationLevel)
