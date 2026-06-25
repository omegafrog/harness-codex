from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def test_ddd_architect_uses_one_cumulative_visualization_section() -> None:
    reference = (ROOT / ".codex/agents/references/ddd_architect.md").read_text(
        encoding="utf-8"
    )
    substeps = (ROOT / ".codex/agents/references/ddd-architect-substep-contract.md").read_text(
        encoding="utf-8"
    )
    template = (ROOT / ".codex/agents/references/ddd-architect-output-template.md").read_text(
        encoding="utf-8"
    )

    assert "## Architecture Visualization" in reference
    assert "one `## Architecture Visualization` section" in substeps
    assert "Use Mermaid" in substeps
    assert "A rerun replaces only the current substep's managed subsection" in reference
    assert "<!-- harness:ddd-visualization:entity_vo:start -->" in template
    assert "Later substeps append their managed Mermaid blocks" in template


def test_ddd_visualization_markers_cover_all_interactive_substeps() -> None:
    reference = (ROOT / ".codex/agents/references/ddd_architect.md").read_text(
        encoding="utf-8"
    )

    for step in (
        "entity_vo",
        "behaviors",
        "application_flow",
        "aggregates",
        "bounded_contexts",
    ):
        assert f"<!-- harness:ddd-visualization:{step}:start -->" in reference
        assert f"<!-- harness:ddd-visualization:{step}:end -->" in reference


def test_candidate_visualization_does_not_promote_shared_contracts() -> None:
    reference = (ROOT / ".codex/agents/references/ddd_architect.md").read_text(
        encoding="utf-8"
    )
    skill = (ROOT / ".codex/skills/harness-ddd-design/SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "Never write `ARCHITECTURE.md`." in reference
    assert "only `harness-ddd-integration` may promote" in skill
