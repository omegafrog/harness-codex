import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".codex" / "skills" / "implement-wrapper" / "SKILL.md"


class ImplementWrapperReconciliationContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = SKILL.read_text(encoding="utf-8")

    def test_completion_report_delegates_gate_and_preserves_status(self):
        self.assertRegex(self.text, r"(?i)completion.{0,180}(implement|subagent).{0,180}(review|blocker)")
        self.assertRegex(self.text, r"(?i)(unresolved review|unresolved blocker).{0,140}(must not|cannot).{0,100}completed")
        self.assertRegex(self.text, r"(?i)(wrapper|scheduler).{0,100}(must not|does not).{0,100}(edit|change).{0,100}(official plan status|plan document)")

    def test_completed_plan_recalculates_only_selected_tracker_dependents(self):
        self.assertRegex(self.text, r"(?i)(completed plan|completion).{0,180}(re-?evaluat|recalculat).{0,180}(dependent|dependency)")
        self.assertIn("selected tracker", self.text)
        self.assertRegex(self.text, r"(?i)(remaining|incomplete|unresolved).{0,120}(planned|waiting)")

    def test_execution_status_does_not_use_triage_labels(self):
        self.assertIn("Do not copy status into a second tracker", self.text)
        self.assertIn("triage labels", self.text)

    def test_graph_reports_an_executable_plan_or_explicitly_blocked_graph(self):
        self.assertRegex(self.text, r"(?i)(at least one|최소 하나).{0,120}(executable)")
        self.assertRegex(self.text, r"(?i)(entire graph|전체 plan graph).{0,160}(blocked|차단)")

    def test_ui_entity_e2e_environment_limitation_is_explicit(self):
        self.assertRegex(self.text, r"(?i)ui\s*~\s*entity")
        self.assertRegex(self.text, r"(?i)(cannot run|unavailable|실행 불가)")
        self.assertRegex(self.text, r"(?i)(environment|환경).{0,160}(blocker|차단).{0,180}(unblock condition|해소 조건)")


if __name__ == "__main__":
    unittest.main()
