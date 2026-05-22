from argparse import Namespace
from pathlib import Path

from harness_codex.cli import changes_contents_command


CHANGESET_MARKDOWN = """# Add note analysis

## 1. Metadata

| Item | Value |
|---|---|
| ChangeSet ID | `CHG-20260522-001` |
| Status | active |
| Related issue/request | #123 |

## 2. Implementation Intent

- Request summary: Add the first note analysis flow.

## 3. Before / After

| Before | After |
|---|---|
| No analysis. | End User can request NoteAnalysis. |

## 4. Changed Documents

| Document | Change Type | Reason | Status |
|---|---|---|---|
| `docs/design/요구사항.md` | update | Add confirmed MVP behavior. | ready |

## 5. Affected Work Items

| Work Item ID | Type | Name | Impact Type | Slice Path | Status |
|---|---|---|---|---|---|
| UC-001 | use_case | Analyze Fleeting Note | add | docs/use-cases/UC-001 | ready |
| MAINT-001 | maintenance | Update runtime docs | update | docs/maintenance/MAINT-001 | ready |

## 7. Planner Input Scope

- `docs/design/요구사항.md`
- `docs/use-cases/UC-001/use-case.md`

## 8. Scope Boundary

### Included
- NoteAnalysis application flow

### Excluded
- Authentication

### Forbidden Changes
- Do not add multi-user workspace support
"""


def test_changes_contents_command_prints_structured_changeset(tmp_path: Path):
    changes_dir = tmp_path / "docs/changes/active"
    changes_dir.mkdir(parents=True)
    (changes_dir / "CHG-20260522-001.md").write_text(CHANGESET_MARKDOWN, encoding="utf-8")

    output = changes_contents_command(
        Namespace(change_set_id="CHG-20260522-001", raw=False),
        tmp_path,
    )

    assert "ChangeSet contents: CHG-20260522-001" in output
    assert "Path: docs/changes/active/CHG-20260522-001.md" in output
    assert "Title: Add note analysis" in output
    assert "Status: active" in output
    assert "Related issue: #123" in output
    assert "Intent: Add the first note analysis flow." in output
    assert "- Before: No analysis." in output
    assert "- After: End User can request NoteAnalysis." in output
    assert "Changed documents:" in output
    assert "- docs/design/요구사항.md [update] status=ready reason=Add confirmed MVP behavior." in output
    assert "Work items:" in output
    assert "- UC-001 (use_case)" in output
    assert "  name: Analyze Fleeting Note" in output
    assert "- MAINT-001 (maintenance)" in output
    assert "Planner inputs:" in output
    assert "- docs/use-cases/UC-001/use-case.md" in output
    assert "Included scope:" in output
    assert "- NoteAnalysis application flow" in output
    assert "Excluded scope:" in output
    assert "- Authentication" in output
    assert "Forbidden changes:" in output
    assert "- Do not add multi-user workspace support" in output


def test_changes_contents_command_raw_prints_changeset_markdown(tmp_path: Path):
    changes_dir = tmp_path / "docs/changes/active"
    changes_dir.mkdir(parents=True)
    (changes_dir / "CHG-20260522-001.md").write_text(CHANGESET_MARKDOWN, encoding="utf-8")

    output = changes_contents_command(
        Namespace(change_set_id="CHG-20260522-001", raw=True),
        tmp_path,
    )

    assert output == CHANGESET_MARKDOWN.strip()
