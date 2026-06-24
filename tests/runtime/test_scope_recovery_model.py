from pathlib import Path

from harness_codex.runtime.scope_violation_recovery_patch import ScopeRecoverySnapshot


def test_scope_recovery_snapshot_keeps_runtime_location(tmp_path: Path) -> None:
    snapshot = ScopeRecoverySnapshot(entries={}, snapshot_dir=tmp_path / "snapshots")
    assert snapshot.entries == {}
    assert snapshot.snapshot_dir == Path(tmp_path / "snapshots")
