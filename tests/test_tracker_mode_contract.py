import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class TrackerModeContractTest(unittest.TestCase):
    def test_setup_persists_one_tracker_mode(self):
        text = (ROOT / ".codex" / "skills" / "setup" / "SKILL.md").read_text(encoding="utf-8")
        self.assertIn("tracker.mode", text)
        self.assertIn("local-markdown", text)
        self.assertIn("GitHub", text)
        self.assertIn("project_owner", text)
        self.assertIn("gh project field-list", text)
        self.assertIn("gh project field-create", text)
        self.assertIn("Workflow Status", text)

    def test_execution_skills_route_to_selected_tracker_only(self):
        for name in ("implement", "to-ticket"):
            text = (ROOT / ".codex" / "skills" / name / "SKILL.md").read_text(encoding="utf-8")
            self.assertIn("tracker mode", text)
            self.assertIn("GitHub mode", text)
            self.assertIn("local-markdown mode", text)
            self.assertNotIn("ready-for-agent", text)

    def test_repository_has_no_triage_contract(self):
        self.assertFalse((ROOT / "docs" / "agents" / "triage-labels.md").exists())
        self.assertFalse((ROOT / "docs" / "adr" / "0001-triage-label-vocabulary.md").exists())


if __name__ == "__main__":
    unittest.main()
