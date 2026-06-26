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
    assert "`behaviors` updates that same graph" in reference
    assert "remove the legacy subsection" in reference
    assert "<!-- harness:ddd-visualization:entity_vo:start -->" in template
    assert "the only Mermaid graph" in template


def test_ddd_visualization_combines_entity_vo_and_behaviors_range() -> None:
    reference = (ROOT / ".codex/agents/references/ddd_architect.md").read_text(
        encoding="utf-8"
    )

    assert "<!-- harness:ddd-visualization:entity_vo:start -->" in reference
    assert "<!-- harness:ddd-visualization:entity_vo:end -->" in reference
    assert "<!-- harness:ddd-visualization:behaviors:start -->" not in reference
    assert "<!-- harness:ddd-visualization:behaviors:end -->" not in reference
    assert "<!-- harness:ddd-visualization:application_flow:start -->" not in reference
    assert "<!-- harness:ddd-visualization:application_flow:end -->" not in reference
    assert "<!-- harness:ddd-visualization:aggregates:start -->" not in reference
    assert "<!-- harness:ddd-visualization:aggregates:end -->" not in reference
    assert "<!-- harness:ddd-visualization:bounded_contexts:start -->" not in reference
    assert "<!-- harness:ddd-visualization:bounded_contexts:end -->" not in reference
    assert "exactly one Mermaid graph" in reference


def test_candidate_visualization_does_not_promote_shared_contracts() -> None:
    reference = (ROOT / ".codex/agents/references/ddd_architect.md").read_text(
        encoding="utf-8"
    )
    skill = (ROOT / ".codex/skills/harness-ddd-design/SKILL.md").read_text(
        encoding="utf-8"
    )

    assert "Never write `ARCHITECTURE.md`." in reference
    assert "only `harness-ddd-integration` may promote" in skill
