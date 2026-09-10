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

    def test_current_config_does_not_choose_tiers_before_setup(self):
        config = self.read(".codex/harness.yaml")

        self.assertNotIn("high_performance_model:", config)
        self.assertNotIn("implementation_model:", config)
        self.assertNotIn("execution_model:", config)
        self.assertNotIn("low_performance_model:", config)

    def test_spec_me_routes_parent_high_and_writers_low(self):
        spec_me = self.read(".codex/skills/spec-me/SKILL.md")

        self.assertIn("agents.high_performance_model", spec_me)
        self.assertIn("agents.high_performance_reasoning_effort", spec_me)
        self.assertIn('agent_type="spec_document_writer"', spec_me)
        self.assertIn("model: agents.low_performance_model", spec_me)
        self.assertIn("reasoning_effort: agents.low_performance_reasoning_effort", spec_me)
        self.assertIn("settled Product decisions", spec_me)
        self.assertIn("settled Architecture decisions", spec_me)
        self.assertIn("planned diagram inventory", spec_me)

    def test_implement_wrapper_routes_implementation_to_standard_tier(self):
        wrapper = self.read(".codex/skills/implement-wrapper/SKILL.md")

        self.assertIn("agents.implementation_model", wrapper)
        self.assertIn("model: agents.implementation_model", wrapper)
        self.assertIn("reasoning_effort: high", wrapper)
        self.assertIn("agents.high_performance_model", wrapper)
        self.assertIn("agents.execution_model", wrapper)
        self.assertIn("agents.execution_reasoning_effort", wrapper)
        self.assertIn("execution_runner", wrapper)
        self.assertIn("explicitly escalate", wrapper)

    def test_writer_owns_spec_markdown_and_diagram_creator_owns_diagrams(self):
        writer = self.read(".codex/agents/spec_document_writer.toml")
        diagrams = self.read(".codex/skills/plantuml-diagrams/SKILL.md")

        self.assertIn("Spec Markdown", writer)
        self.assertIn("diagram inventory", diagrams)
        self.assertIn("spec_document_writer", diagrams)


if __name__ == "__main__":
    unittest.main()
