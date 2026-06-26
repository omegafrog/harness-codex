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
    assert "`behaviors` updates the existing entity/VO subsection" in reference
    assert "remove the legacy subsection" in reference
    assert "<!-- harness:ddd-visualization:entity_vo:start -->" in template
    assert "`behaviors` updates the same managed range" in template


def test_ddd_visualization_combines_entity_vo_and_behaviors_range() -> None:
    reference = (ROOT / ".codex/agents/references/ddd_architect.md").read_text(
        encoding="utf-8"
    )

    for step in (
        "entity_vo",
        "application_flow",
        "aggregates",
        "bounded_contexts",
    ):
        assert f"<!-- harness:ddd-visualization:{step}:start -->" in reference
        assert f"<!-- harness:ddd-visualization:{step}:end -->" in reference
    assert "<!-- harness:ddd-visualization:behaviors:start -->" not in reference
    assert "<!-- harness:ddd-visualization:behaviors:end -->" not in reference


def test_candidate_visualization_does_not_promote_shared_contracts() -> None:
    reference = (ROOT / ".codex/agents/references/ddd_architect.md").read_text(
        encoding="utf-8"
    )
    skill = (ROOT / ".codex/skills/harness-ddd-design/SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "Never write `ARCHITECTURE.md`." in reference
    assert "only `harness-ddd-integration` may promote" in skill
