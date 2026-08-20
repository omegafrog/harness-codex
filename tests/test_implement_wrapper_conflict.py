import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".codex" / "skills" / "implement-wrapper" / "SKILL.md"


class ImplementWrapperConflictContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = SKILL.read_text(encoding="utf-8")

    def test_conflict_pauses_related_slots_without_automatic_merge(self):
        self.assertIn("conflict evidence", self.text)
        self.assertIn("stops the related execution slots", self.text)
        self.assertIn("conflict-paused", self.text)
        self.assertRegex(self.text, r"(?i)(does not|must not).{0,100}(automatically merge|자동.*병합)")

    def test_priority_decision_gates_resume_and_selected_plan_runs_first(self):
        self.assertIn("cannot resume before the main session makes an explicit priority decision", self.text)
        self.assertIn("selects exactly one affected plan to resume first", self.text)
        self.assertIn("remaining plans are re-evaluated", self.text)

    def test_checkpoint_supports_conflict_orchestration_states_and_evidence(self):
        self.assertIn("conflict-paused", self.text)
        self.assertIn("priority-routed", self.text)
        self.assertRegex(self.text, r"(?i)(conflict evidence|충돌 증거).{0,160}(checkpoint|체크포인트)")
        self.assertIn("affected plan ids in each related plan's checkpoint", self.text)

    def test_blocker_report_has_kind_summary_and_exact_unblock_condition(self):
        self.assertRegex(self.text, r"(?i)blocker.{0,180}(kind|종류).{0,180}(summary|요약).{0,180}(unblock condition|해소 조건)")
        self.assertRegex(self.text, r"(?i)(code|environment|decision|conflict)")
        self.assertIn("implementing subagent owns code blocker resolution", self.text)
        self.assertIn("external environment, authority, dependency, or decision blocker", self.text)

    def test_official_status_remains_within_existing_five_states(self):
        self.assertIn("official plan status", self.text)
        for status in ("planned", "ready-for-agent", "in-progress", "completed", "blocked"):
            self.assertIn(status, self.text)
        self.assertNotRegex(self.text, r"official plan status.{0,120}(conflict-paused|priority-routed)")

    def test_ui_entity_e2e_environment_limitation_is_explicit(self):
        self.assertRegex(self.text, r"(?i)ui\s*~\s*entity")
        self.assertRegex(self.text, r"(?i)(cannot run|unavailable|실행 불가)")
        self.assertRegex(self.text, r"(?i)(environment|환경).{0,160}(blocker|차단).{0,180}(unblock condition|해소 조건)")


if __name__ == "__main__":
    unittest.main()
