import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".codex" / "skills" / "implement-wrapper" / "SKILL.md"


class ImplementWrapperSchedulerContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = SKILL.read_text(encoding="utf-8")

    def test_dependency_free_plans_are_candidates_and_dependencies_wait(self):
        self.assertIn("Planned", self.text)
        self.assertIn("candidate", self.text)
        self.assertRegex(self.text, r"(?i)(dependency|dependencies).{0,120}(completion|wait|대기)")
        self.assertRegex(self.text, r"(?i)shared resource.{0,100}(conflict|충돌|sequential|순차)")

    def test_one_execution_slot_per_plan(self):
        self.assertRegex(self.text, r"(?i)(one|single|at most one).{0,80}(execution )?slot")
        self.assertRegex(self.text, r"(?i)(same|each) plan.{0,80}(one|single|하나)")

    def test_independent_plans_can_spawn_in_parallel(self):
        self.assertRegex(self.text, r"(?i)independent.{0,100}(parallel|동시)")
        self.assertRegex(self.text, r"(?i)(spawn|start).{0,100}(parallel|병렬)")

    def test_prompt_contract_contains_required_paths_and_scope(self):
        for required in (
            "docs/plans/<plan-set-id>/plans.md",
            "docs/specs/product-spec.md",
            "docs/specs/architecture-spec.md",
            ".codex/skills/implement/SKILL.md",
            "plan path",
        ):
            self.assertIn(required, self.text)
        self.assertRegex(self.text, r"(?i)(exactly one|one) plan")
        self.assertRegex(self.text, r"(?i)(do not|must not).{0,80}(checkpoint|conflict|reconciliation)")

    def test_scheduler_contract_is_explicitly_non_ui_e2e(self):
        self.assertRegex(self.text, r"(?i)ui\s*~\s*entity")
        self.assertRegex(self.text, r"(?i)(unavailable|cannot run|not available|실행 불가)")
        self.assertRegex(self.text, r"(?i)(environment|환경).{0,100}(blocker|차단|condition)")


if __name__ == "__main__":
    unittest.main()
