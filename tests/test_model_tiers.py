from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ModelTierContractTest(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_setup_asks_for_and_persists_three_model_tiers(self):
        setup = self.read(".codex/skills/setup/SKILL.md")

        self.assertIn("currently available subagent model choices", setup)
        self.assertIn("high-performance", setup)
        self.assertIn("implementation", setup)
        self.assertIn("execution", setup)
        self.assertIn("low-performance", setup)
        self.assertIn("agents.high_performance_model", setup)
        self.assertIn("high_performance_reasoning_effort", setup)
        self.assertIn("agents.implementation_model", setup)
        self.assertIn("implementation_reasoning_effort", setup)
        self.assertIn("agents.execution_model", setup)
        self.assertIn("execution_reasoning_effort", setup)
        self.assertIn("agents.low_performance_model", setup)
        self.assertIn("low_performance_reasoning_effort", setup)
        self.assertIn("default_model", setup)
        self.assertIn("legacy fallback", setup)
        self.assertIn("Do not use a hardcoded or stale model list", setup)
        self.assertIn("numbered, selectable list", setup)
        self.assertIn("현재값", setup)
        self.assertIn("exact model ID", setup)
        self.assertIn("final selection summary", setup)

    def test_current_config_binds_all_model_tiers(self):
        config = self.read(".codex/harness.yaml")

        for key in (
            "high_performance_model:", "high_performance_reasoning_effort:",
            "implementation_model:", "implementation_reasoning_effort:",
            "execution_model:", "execution_reasoning_effort:",
            "low_performance_model:", "low_performance_reasoning_effort:",
            "default_model:",
        ):
            self.assertIn(key, config)

    def test_workflow_stages_bind_model_tiers(self):
        for relative in (
            ".codex/workflows/spec-me.yaml",
            ".codex/workflows/code-review.yaml",
            ".codex/workflows/implement-wrapper.yaml",
            ".codex/workflows/to-ticket.yaml",
        ):
            text = self.read(relative)
            self.assertIn("model_tier:", text)

    def test_spec_me_routes_parent_high_and_writers_low(self):
        spec_me = self.read(".codex/skills/spec-me/SKILL.md")

        self.assertIn("agents.high_performance_model", spec_me)
        self.assertIn("agents.high_performance_reasoning_effort", spec_me)
        self.assertIn('agent_type="spec_document_writer"', spec_me)
        self.assertIn("model: resolved_low_performance_model_id", spec_me)
        self.assertIn("reasoning_effort: resolved_low_performance_reasoning_effort", spec_me)
        self.assertIn("settled Product decisions", spec_me)
        self.assertIn("settled Architecture decisions", spec_me)
        self.assertIn("planned diagram inventory", spec_me)

    def test_spec_me_resolves_low_model_and_fails_closed(self):
        spec_me = self.read(".codex/skills/spec-me/SKILL.md")

        self.assertRegex(spec_me, r"(?i)resolve.{0,120}(actual|resolved).{0,120}model")
        self.assertRegex(spec_me, r"(?i)(never|do not|must not).{0,120}(literal|config key)")
        self.assertIn("agents.low_performance_model", spec_me)
        self.assertRegex(spec_me, r"(?i)low.?performance.{0,180}(missing|invalid|unavailable).{0,180}(stop|block|setup)")
        self.assertRegex(spec_me, r"(?i)(never|must not|do not).{0,140}(omit|inherit|fallback).{0,180}(parent|high.?performance)")
        for role in ("spec_document_writer", "diagram_creator"):
            self.assertRegex(spec_me, rf'agent_type="{role}"')

    def test_lightweight_roles_require_resolved_low_model(self):
        for relative in (
            ".codex/agents/spec_document_writer.toml",
            ".codex/agents/diagram_creator.toml",
        ):
            text = self.read(relative)
            self.assertIn("resolved `agents.low_performance_model`", text)
            self.assertIn("`agents.low_performance_reasoning_effort`", text)
            self.assertRegex(text, r"(?i)(never|do not).{0,80}inherit.{0,80}parent model")

    def test_implement_wrapper_does_not_force_a_model_tier(self):
        wrapper = self.read(".codex/skills/implement-wrapper/SKILL.md")

        self.assertNotIn("agents.implementation_model", wrapper)
        self.assertNotIn("model: agents.implementation_model", wrapper)
        self.assertNotIn("reasoning_effort: high", wrapper)
        self.assertNotIn("agents.high_performance_model", wrapper)
        self.assertNotIn("agents.execution_model", wrapper)
        self.assertNotIn("agents.execution_reasoning_effort", wrapper)
        self.assertIn("execution_runner", wrapper)
        self.assertIn("runtime policy", wrapper)

    def test_writer_owns_spec_markdown_and_diagram_creator_owns_diagrams(self):
        writer = self.read(".codex/agents/spec_document_writer.toml")
        diagrams = self.read(".codex/skills/plantuml-diagrams/SKILL.md")

        self.assertIn("Spec Markdown", writer)
        self.assertIn("diagram inventory", diagrams)
        self.assertIn("spec_document_writer", diagrams)


if __name__ == "__main__":
    unittest.main()
