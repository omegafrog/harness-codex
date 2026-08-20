import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / ".codex" / "skills" / "implement-wrapper" / "SKILL.md"
GITIGNORE = ROOT / ".gitignore"


class ImplementWrapperCheckpointContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = SKILL.read_text(encoding="utf-8")
        cls.gitignore = GITIGNORE.read_text(encoding="utf-8")

    def test_prompt_contains_checkpoint_path_and_schema(self):
        self.assertIn("docs/plans/.runtime/<plan-id>/checkpoint.md", self.text)
        for field in (
            "plan_id",
            "orchestration_state",
            "attempt",
            "last_completed_step",
            "changed_files",
            "tests",
            "blocker",
            "next_action",
            "handoff_reason",
            "updated_at",
        ):
            self.assertRegex(self.text, rf"(?m)^\s*{field}:")
        self.assertRegex(self.text, r"(?i)handoff_reason.{0,100}(context-threshold|milestone)")

    def test_handoff_resumes_same_plan_in_progress(self):
        self.assertRegex(self.text, r"(?i)handoff.{0,180}(same plan|동일 plan).{0,180}(resume|재개)")
        self.assertRegex(self.text, r"(?i)resume.{0,160}in-progress")
        self.assertRegex(self.text, r"(?i)(one|single).{0,100}(slot|subagent).{0,100}(resume|재개)")

    def test_actual_git_and_test_state_wins_on_checkpoint_mismatch(self):
        self.assertRegex(self.text, r"(?i)(checkpoint|체크포인트).{0,180}(Git/test|git.*test|실제).{0,180}(actual|우선|source of truth)")
        self.assertRegex(self.text, r"(?i)(correct|보정|rewrite|갱신).{0,120}checkpoint")

    def test_checkpoint_is_ignored_and_does_not_replace_official_status(self):
        self.assertIn("docs/plans/.runtime/", self.gitignore)
        self.assertRegex(self.text, r"(?i)checkpoint.{0,180}(gitignore|ignored|무시)")
        self.assertRegex(self.text, r"(?i)checkpoint.{0,180}(does not replace|never replaces|대체하지).{0,80}(official plan status|공식 plan status)")

    def test_ui_entity_e2e_environment_limitation_is_explicit(self):
        self.assertRegex(self.text, r"(?i)ui\s*~\s*entity")
        self.assertRegex(self.text, r"(?i)(cannot run|unavailable|실행 불가)")
        self.assertRegex(self.text, r"(?i)(environment|환경).{0,120}(blocker|차단|unblock condition)")


if __name__ == "__main__":
    unittest.main()
