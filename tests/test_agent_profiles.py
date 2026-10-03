from pathlib import Path
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]
AGENTS = ROOT / ".codex" / "agents"


class AgentProfileContractTest(unittest.TestCase):
    expected = {
        "code_researcher": "code-research",
        "architecture_review_lead": "architecture-review",
        "diagram_creator": "plantuml-diagrams",
        "spec_document_writer": "product-spec",
        "execution_runner": None,
        "e2e_test_runner": "e2e-test",
        "implementation_agent": "implement",
        "standards_reviewer": "code-review",
        "spec_reviewer": "code-review",
        "to_ticket": "to-ticket",
        "frontend_designer": "frontend-design",
        "frontend_implementation_agent": "frontend-implement",
        "frontend_visual_reviewer": "frontend-visual-review",
        "knowledge_source_researcher": "knowledge-harvest",
        "knowledge_claim_extractor": "knowledge-harvest",
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
                if skill_name is not None:
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

    def test_architecture_review_lead_is_a_read_only_high_tier_challenger(self):
        data = tomllib.loads((AGENTS / "architecture_review_lead.toml").read_text(encoding="utf-8"))

        self.assertEqual(data["model_reasoning_effort"], "high")
        self.assertEqual(data["sandbox_mode"], "read-only")
        self.assertIn("do not supply answers", data["developer_instructions"])
        self.assertIn("explicit use approval", data["developer_instructions"])

    def test_spec_document_writer_is_lightweight_and_decision_free(self):
        data = tomllib.loads((AGENTS / "spec_document_writer.toml").read_text(encoding="utf-8"))

        self.assertEqual(data["model_reasoning_effort"], "low")
        self.assertEqual(data["sandbox_mode"], "workspace-write")
        self.assertIn("spec_document_writer", data["developer_instructions"])
        self.assertIn("Do not ask questions", data["developer_instructions"])
        self.assertIn("Do not make product decisions", data["developer_instructions"])
        self.assertIn("Do not make architecture decisions", data["developer_instructions"])

    def test_frontend_agents_are_isolated_from_generic_implementation_workflow(self):
        designer = tomllib.loads((AGENTS / "frontend_designer.toml").read_text(encoding="utf-8"))
        implementer = tomllib.loads((AGENTS / "frontend_implementation_agent.toml").read_text(encoding="utf-8"))
        reviewer = tomllib.loads((AGENTS / "frontend_visual_reviewer.toml").read_text(encoding="utf-8"))

        self.assertEqual(designer["sandbox_mode"], "read-only")
        self.assertEqual(implementer["sandbox_mode"], "workspace-write")
        self.assertEqual(reviewer["sandbox_mode"], "workspace-write")

        self.assertIn("frontend-design", designer["developer_instructions"])
        self.assertIn("frontend-implement", implementer["developer_instructions"])
        self.assertIn("frontend-visual-review", reviewer["developer_instructions"])
        self.assertIn("frontend-figma", designer["developer_instructions"])
        self.assertIn("frontend-figma", implementer["developer_instructions"])
        self.assertIn("frontend-figma", reviewer["developer_instructions"])
        self.assertIn("Figwright", designer["developer_instructions"])
        self.assertIn("get_design_context", implementer["developer_instructions"])
        self.assertIn("Figma evidence", reviewer["developer_instructions"])

        self.assertIn("Do not invoke generic implement", implementer["developer_instructions"])
        self.assertIn("Do not edit application source", reviewer["developer_instructions"])
        self.assertIn("actual rendered screenshots", reviewer["developer_instructions"])

    def test_execution_runner_is_runtime_only_and_polling_scoped(self):
        data = tomllib.loads((AGENTS / "execution_runner.toml").read_text(encoding="utf-8"))

        self.assertEqual(data["model_reasoning_effort"], "medium")
        self.assertEqual(data["sandbox_mode"], "workspace-write")
        self.assertIn("poll until completion", data["developer_instructions"])
        self.assertIn("Do not edit implementation files", data["developer_instructions"])
        self.assertIn("Never convert a timeout", data["developer_instructions"])


if __name__ == "__main__":
    unittest.main()
