from pathlib import Path

from harness_codex.runtime.changes.work_item_documents import main


def test_scaffold_command_generates_and_checks_bug_fix_documents(
    tmp_path: Path,
    capsys,
) -> None:
    change_set_path = tmp_path / "docs/changes/active/CHG-001.md"
    change_set_path.parent.mkdir(parents=True)
    change_set_path.write_text(
        """# ChangeSet CHG-001

## 1. Metadata
|Item|Value|
|---|---|
|ChangeSet ID|`CHG-001`|
|Status|active|

## 5. Affected Work Items
|Work Item ID|Type|Name|Impact Type|Slice Path|Status|
|---|---|---|---|---|---|
|`BUG-042`|bug_fix|Duplicate queue admission after reconnect|fix|`docs/maintenance/BUG-042/`|planned|
""",
        encoding="utf-8",
    )

    assert main(
        [
            "--repo-root",
            str(tmp_path),
            "--change-set",
            "CHG-001",
            "--work-item",
            "BUG-042",
        ]
    ) == 0
    assert "reproduction.md" in capsys.readouterr().out

    expected = (
        "brief.md",
        "architecture-impact.md",
        "verification-goal.md",
        "links.md",
        "reproduction.md",
        "regression-goal.md",
    )
    for filename in expected:
        assert (tmp_path / "docs/maintenance/BUG-042" / filename).is_file()

    assert main(
        [
            "--repo-root",
            str(tmp_path),
            "--change-set",
            "CHG-001",
            "--work-item",
            "BUG-042",
            "--check",
        ]
    ) == 0
    assert "PASS: typed work-item document contracts are complete" in capsys.readouterr().out
