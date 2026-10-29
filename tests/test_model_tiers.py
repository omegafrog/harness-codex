from pathlib import Path
import json
import unittest

ROOT = Path(__file__).resolve().parents[1]

class ModelTierContractTest(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text(encoding="utf-8")

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

    def test_public_skills_have_configured_execution_bindings(self):
        bindings = json.loads(self.read(".codex/internal-skills/skill-execution/bindings.json"))
        for path in (ROOT / ".codex/skills").glob("*/SKILL.md"):
            if path.parent.name in bindings["main_session_skills"]:
                self.assertNotIn(path.parent.name, bindings["skills"])
                continue
            tier = bindings["skills"][path.parent.name]
            self.assertIn(tier, bindings["tiers"])
            self.assertTrue(bindings["tiers"][tier]["model_key"].startswith("agents."))
            self.assertTrue(bindings["tiers"][tier]["reasoning_effort_key"].startswith("agents."))

if __name__ == "__main__":
    unittest.main()
