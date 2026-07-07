import json
from pathlib import Path

from harness_codex.runtime.ddd_candidate_rollback_patch import (
    _capture_candidate,
    _restore_candidate,
    _write_rollback_receipt,
)


def test_restores_previous_candidate_after_unaccepted_attempt(tmp_path: Path) -> None:
    change_set_id = "CHG-20260707-1"
    uc_id = "UC-001"
    candidate = tmp_path / "docs" / "use-cases" / uc_id / "ddd-design.md"
    candidate.parent.mkdir(parents=True)
    candidate.write_text("previous valid candidate", encoding="utf-8")

    snapshot = _capture_candidate(tmp_path, change_set_id, uc_id)
    candidate.write_text("partial invalid candidate", encoding="utf-8")

    _restore_candidate(tmp_path, uc_id, snapshot)
    _write_rollback_receipt(
        tmp_path,
        change_set_id,
        uc_id,
        snapshot,
        restored=True,
        reason="DDD candidate input hash mismatch",
    )

    assert candidate.read_text(encoding="utf-8") == "previous valid candidate"
    receipt = tmp_path / ".harness" / "contracts" / change_set_id / uc_id / "ddd-candidate.rollback.json"
    payload = json.loads(receipt.read_text(encoding="utf-8"))
    assert payload["restored"] is True
    assert payload["before"]["existed"] is True


def test_removes_new_partial_candidate_when_no_previous_candidate_existed(tmp_path: Path) -> None:
    change_set_id = "CHG-20260707-1"
    uc_id = "UC-001"
    candidate = tmp_path / "docs" / "use-cases" / uc_id / "ddd-design.md"

    snapshot = _capture_candidate(tmp_path, change_set_id, uc_id)
    candidate.parent.mkdir(parents=True)
    candidate.write_text("partial candidate", encoding="utf-8")

    _restore_candidate(tmp_path, uc_id, snapshot)

    assert not candidate.exists()
