import hashlib
from pathlib import Path

from harness_codex.runtime.ddd_candidate_input_integrity_patch import (
    _declared_input_hashes,
    _expected_hashes,
    _validate_all_input_hashes,
)


def _write_sources(root: Path, change_set_id: str, uc_id: str) -> None:
    files = {
        root / "docs" / "changes" / "active" / f"{change_set_id}.md": "# change\n",
        root / "docs" / "use-cases" / uc_id / "use-case.md": "# use case\n",
        root / "docs" / "use-cases" / uc_id / "event-storming.md": "# event storming\n",
        root / "docs" / "use-cases" / uc_id / "e2e-goal.md": "# e2e goal\n",
    }
    for path, text in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def _candidate(change_set_id: str, uc_id: str, hashes: dict[str, str]) -> str:
    return f"""---
status: candidate
change_set: {change_set_id}
work_item: {uc_id}
input_hashes:
  change_set_document: {hashes['change_set_document']}
  use_case: {hashes['use_case']}
  event_storming: {hashes['event_storming']}
  e2e_goal: {hashes['e2e_goal']}
---
# candidate
"""


def test_validates_all_declared_ddd_source_hashes(tmp_path: Path) -> None:
    change_set_id = "CHG-20260707-1"
    uc_id = "UC-001"
    _write_sources(tmp_path, change_set_id, uc_id)
    hashes = _expected_hashes(tmp_path, change_set_id, uc_id)
    candidate = tmp_path / "docs" / "use-cases" / uc_id / "ddd-design.md"
    candidate.write_text(_candidate(change_set_id, uc_id, hashes), encoding="utf-8")

    assert _validate_all_input_hashes(tmp_path, change_set_id, uc_id) == ""


def test_rejects_stale_e2e_goal_hash(tmp_path: Path) -> None:
    change_set_id = "CHG-20260707-1"
    uc_id = "UC-001"
    _write_sources(tmp_path, change_set_id, uc_id)
    hashes = _expected_hashes(tmp_path, change_set_id, uc_id)
    hashes["e2e_goal"] = "sha256:" + "0" * 64
    candidate = tmp_path / "docs" / "use-cases" / uc_id / "ddd-design.md"
    candidate.write_text(_candidate(change_set_id, uc_id, hashes), encoding="utf-8")

    assert _validate_all_input_hashes(tmp_path, change_set_id, uc_id) == "DDD candidate input hash mismatch for `e2e_goal`"


def test_rejects_missing_change_set_document_hash(tmp_path: Path) -> None:
    change_set_id = "CHG-20260707-1"
    uc_id = "UC-001"
    _write_sources(tmp_path, change_set_id, uc_id)
    hashes = _expected_hashes(tmp_path, change_set_id, uc_id)
    candidate = tmp_path / "docs" / "use-cases" / uc_id / "ddd-design.md"
    candidate.write_text(
        _candidate(change_set_id, uc_id, hashes).replace(
            f"  change_set_document: {hashes['change_set_document']}\n",
            "",
        ),
        encoding="utf-8",
    )

    assert _validate_all_input_hashes(tmp_path, change_set_id, uc_id) == "DDD candidate input_hashes is missing `change_set_document`"


def test_parses_only_nested_input_hashes() -> None:
    content = """---
change_set: CHG-1
input_hashes:
  change_set_document: sha256:abc
  use_case: sha256:def
  event_storming: sha256:ghi
  e2e_goal: sha256:jkl
---
"""

    assert _declared_input_hashes(content) == {
        "change_set_document": "sha256:abc",
        "use_case": "sha256:def",
        "event_storming": "sha256:ghi",
        "e2e_goal": "sha256:jkl",
    }
