from __future__ import annotations

from pathlib import Path

from harness_codex.runtime import change_set_pr_delivery as pr_delivery


def test_delivery_requires_rerun_when_final_diff_exceeds_declared_impact(tmp_path: Path) -> None:
    change_set = tmp_path / "docs/changes/active/CHG-377.md"
    change_set.parent.mkdir(parents=True)
    change_set.write_text(
        """# ChangeSet CHG-377

## 1. Metadata
|Item|Value|
|---|---|
|ChangeSet ID|`CHG-377`|
|Status|active|

## 5. Affected Work Items
|Work Item ID|Type|Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|---|
|`MAINT-377`|maintenance|Update documentation|documentation update|`docs/maintenance/MAINT-377/`|planned|
""",
        encoding="utf-8",
    )

    escalations = pr_delivery._reconcile_final_changed_paths(
        tmp_path,
        "CHG-377",
        ("src/auth/token_validator.py",),
    )

    assert {item.gate_id for item in escalations} == {
        "security-review",
        "static-analysis",
        "test-gate",
    }
