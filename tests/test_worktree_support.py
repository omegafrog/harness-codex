from __future__ import annotations

from harness_codex.runtime.worktree_support import committable_status_paths, safe_ref_part


def test_safe_ref_part_removes_git_unsafe_characters() -> None:
    assert safe_ref_part(" CHG/alpha:beta ") == "CHG-alpha-beta"
    assert safe_ref_part("...") == "item"


def test_committable_status_paths_excludes_runtime_links() -> None:
    status = (
        " M docs/design/요구사항.md\0"
        "?? .harness/runs/run-1/state.json\0"
        "?? harness_codex/runtime/engine.py\0"
        "?? venv/lib/python\0"
    )

    assert committable_status_paths(status) == ("docs/design/요구사항.md",)
