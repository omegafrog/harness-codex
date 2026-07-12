from __future__ import annotations

from pathlib import Path

from harness_codex.orchestration.runtime_context import context


def test_context_exposes_active_changeset_resume_facts(tmp_path: Path) -> None:
    source = Path(__file__).parents[1]
    workflow_dir = tmp_path / ".harness/workflows"
    workflow_dir.mkdir(parents=True)
    (workflow_dir / "changeset-use-case-workflow.yaml").write_text((source / ".harness/workflows/changeset-use-case-workflow.yaml").read_text(encoding="utf-8"), encoding="utf-8")
    active = tmp_path / "docs/changes/active"
    active.mkdir(parents=True)
    (active / "CHG-001.md").write_text("# CHG-001\n", encoding="utf-8")

    facts = context(repo_root=tmp_path, run_id="run-1")

    assert facts["run_id"] == "run-1"
    assert facts["active_change_sets"][0]["change_set_id"] == "CHG-001"
