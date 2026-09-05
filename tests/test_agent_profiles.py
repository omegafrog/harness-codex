from pathlib import Path
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".codex" / "agents"


class AgentProfileContractTest(unittest.TestCase):
    expected = {
        "code_researcher": "code-research",
        "diagram_creator": "plantuml-diagrams",
        "standards_reviewer": "code-review",
        "spec_reviewer": "code-review",
    }

    def test_current_agent_profiles_are_present_and_valid(self):
        profiles = sorted(AGENTS.glob("*.toml"))
        self.assertEqual(
            {profile.stem for profile in profiles}, set(self.expected)
        )

        for profile in profiles:
            with self.subTest(profile=profile.name):
                data = tomllib.loads(profile.read_text(encoding="utf-8"))
                self.assertEqual(data["name"], profile.stem)
                self.assertTrue(data["description"])
                self.assertTrue(data["developer_instructions"])
                self.assertIn("sandbox_mode", data)

                skill_name = self.expected[profile.stem]
                skill_path = ROOT / ".codex" / "skills" / skill_name / "SKILL.md"
                self.assertTrue(skill_path.is_file())
                self.assertIn(
                    f".codex/skills/{skill_name}/SKILL.md",
                    data["developer_instructions"],
                )

    def test_diagram_creator_is_lightweight_and_write_scoped(self):
        data = tomllib.loads((AGENTS / "diagram_creator.toml").read_text(encoding="utf-8"))

        self.assertEqual(data["model_reasoning_effort"], "low")
        self.assertEqual(data["sandbox_mode"], "workspace-write")
        self.assertIn("docs/specs/<ticket-id>/diagrams/", data["developer_instructions"])
        self.assertIn("plantuml-diagrams", data["developer_instructions"])
        self.assertIn("Do not make product or architecture decisions", data["developer_instructions"])


if __name__ == "__main__":
    unittest.main()
