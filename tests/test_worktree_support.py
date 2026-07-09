from __future__ import annotations

from pathlib import Path

from harness_codex.runtime.worktree_support import (
    committable_status_paths,
    hydrate_runtime_worktree,
    safe_ref_part,
)


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


def test_committable_status_paths_keeps_renamed_destination() -> None:
    # Porcelain v1 -z puts the new path in the status record and the old path
    # in the following NUL-delimited field.
    status = "R  docs/new.md\0docs/old.md\0"

    assert committable_status_paths(status) == ("docs/new.md",)


def test_hydrate_runtime_worktree_copies_ignored_harness_artifacts(tmp_path: Path) -> None:
    source = tmp_path / "source"
    target = tmp_path / "target"
    (source / ".harness/docs/agent").mkdir(parents=True)
    (source / ".harness/docs/agent/context.md").write_text("# context\n", encoding="utf-8")
    (source / ".harness/agents").mkdir(parents=True)
    (source / ".harness/agents/scope-support.toml").write_text("version = \"1\"\n", encoding="utf-8")
    (source / "docs/maintenance/BUG-001").mkdir(parents=True)
    (source / "docs/maintenance/BUG-001/index.md").write_text("# bug\n", encoding="utf-8")
    (source / "docs/changes/active").mkdir(parents=True)
    (source / "docs/changes/active/CHG-001.md").write_text("# change\n", encoding="utf-8")
    (source / ".harness/workflows").mkdir(parents=True)
    (source / "harness_codex").mkdir(parents=True)
    (source / ".codex/agents").mkdir(parents=True)
    (source / ".codex/skills").mkdir(parents=True)
    (source / "harness").write_text("#!/bin/sh\n", encoding="utf-8")

    hydrate_runtime_worktree(source, target, copy_project_docs=True)

    assert (target / ".harness/runs").is_symlink()
    assert (target / ".harness/docs/agent/context.md").read_text(encoding="utf-8") == "# context\n"
    assert (target / ".harness/agents/scope-support.toml").read_text(encoding="utf-8") == 'version = "1"\n'
    assert (target / "docs/maintenance/BUG-001/index.md").read_text(encoding="utf-8") == "# bug\n"
    assert (target / "docs/changes/active/CHG-001.md").read_text(encoding="utf-8") == "# change\n"
    assert (target / "harness_codex").is_symlink()
