from pathlib import Path

from harness_codex.cli import _continue_uc_for_stage
from harness_codex.runtime.changes.models import ChangeSet


def test_continue_implementation_preserves_uc_override() -> None:
    change_set = ChangeSet(
        change_set_id="CHG-TEST-001",
        title="테스트 변경",
    )

    assert (
        _continue_uc_for_stage(
            Path("."),
            change_set,
            "implementation",
            "UC-001",
        )
        == "UC-001"
    )
