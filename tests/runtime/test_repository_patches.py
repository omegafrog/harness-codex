from __future__ import annotations

import json
from pathlib import Path

from harness_codex.runtime.repository_patches.apply import apply_repository_patches


def test_harness_docs_boundary_patch_moves_legacy_docs(tmp_path: Path) -> None:
    agent_context = tmp_path / "docs/agent/context.md"
    template = tmp_path / "docs/templates/changes/change-set.md"
    runtime_doc = tmp_path / "docs/runtime-update-command.md"
    agent_context.parent.mkdir(parents=True)
    template.parent.mkdir(parents=True)
    runtime_doc.parent.mkdir(parents=True, exist_ok=True)
    agent_context.write_text("# Context\n", encoding="utf-8")
    template.write_text("# ChangeSet\n", encoding="utf-8")
    runtime_doc.write_text("# Update\n", encoding="utf-8")

    results = apply_repository_patches(tmp_path)
    result = next(item for item in results if item.patch_id == "0002-harness-docs-boundary")

    assert "docs/agent -> .harness/docs/agent" in result.moved_paths
    assert "docs/templates -> .harness/docs/templates" in result.moved_paths
    assert (
        "docs/runtime-update-command.md -> .harness/docs/runtime/update-command.md"
        in result.moved_paths
    )
    assert (tmp_path / ".harness/docs/agent/context.md").read_text(encoding="utf-8") == "# Context\n"
    assert (tmp_path / ".harness/docs/templates/changes/change-set.md").is_file()
    assert (tmp_path / ".harness/docs/runtime/update-command.md").is_file()
    assert not (tmp_path / "docs/agent").exists()
    assert not (tmp_path / "docs/templates").exists()

    rerun = apply_repository_patches(tmp_path)
    rerun_result = next(item for item in rerun if item.patch_id == "0002-harness-docs-boundary")
    assert rerun_result.skipped is True


def test_harness_docs_boundary_patch_reports_conflict_without_overwrite(
    tmp_path: Path,
) -> None:
    source = tmp_path / "docs/agent/context.md"
    target = tmp_path / ".harness/docs/agent/context.md"
    source.parent.mkdir(parents=True)
    target.parent.mkdir(parents=True)
    source.write_text("# Old Context\n", encoding="utf-8")
    target.write_text("# Existing Context\n", encoding="utf-8")

    results = apply_repository_patches(tmp_path)
    result = next(item for item in results if item.patch_id == "0002-harness-docs-boundary")

    assert "docs/agent -> .harness/docs/agent" in result.conflicts
    assert target.read_text(encoding="utf-8") == "# Existing Context\n"
    assert source.read_text(encoding="utf-8") == "# Old Context\n"

    state = json.loads(
        (
            tmp_path
            / ".harness/state/repository-patches/0002-harness-docs-boundary.json"
        ).read_text(encoding="utf-8")
    )
    assert state["conflicts"] == ["docs/agent -> .harness/docs/agent"]
