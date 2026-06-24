from pathlib import Path

from harness_codex.runtime.scope_violation_recovery_patch import (
    ScopeRecoverySnapshot,
    recover_scope_violation,
)


def test_scope_recovery_reports_unsafe_paths_as_recovery_failures(tmp_path: Path) -> None:
    report = tmp_path / "scope-diff-report.json"
    report.write_text("{}\n", encoding="utf-8")
    snapshot = ScopeRecoverySnapshot(entries={}, snapshot_dir=tmp_path / "snapshot")

    result = recover_scope_violation(
        repo_root=tmp_path,
        step_dir=tmp_path / "step",
        scope_report_path=report,
        snapshot=snapshot,
        blocked_files=("../outside.txt",),
    )

    assert result.recovered_files == ()
    assert result.failed_files
    assert result.failed_files[0]["path"] == "../outside.txt"
    assert result.report_path.is_file()
