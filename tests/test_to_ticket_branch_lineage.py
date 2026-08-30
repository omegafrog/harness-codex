from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
TO_TICKET = ROOT / ".codex" / "skills" / "to-ticket" / "SKILL.md"
GH_OPEN_PR = ROOT / ".codex" / "skills" / "gh-open-pr" / "SKILL.md"


class ToTicketBranchLineageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.to_ticket = TO_TICKET.read_text(encoding="utf-8")
        cls.gh_open_pr = GH_OPEN_PR.read_text(encoding="utf-8")

    def test_does_not_unconditionally_branch_from_origin_main(self):
        self.assertNotIn("Create new branch for entire plan set from origin/main", self.to_ticket)

    def test_plan_branch_uses_session_current_branch_as_base(self):
        self.assertRegex(
            self.to_ticket,
            r"(?is)(current session|session).{0,300}(current branch).{0,300}(base branch).{0,300}(HEAD).{0,300}(fixed base ref)",
        )

    def test_does_not_infer_dependency_or_switch_to_default_branch(self):
        self.assertNotRegex(self.to_ticket, r"(?is)unmerged predecessor|continuation dependency")
        self.assertIn("Do not switch to the remote default branch", self.to_ticket)

    def test_plan_pr_uses_caller_captured_session_base_branch(self):
        self.assertRegex(
            self.gh_open_pr,
            r"(?is)(current session|session).{0,300}(base branch).{0,300}(--base)",
        )


if __name__ == "__main__":
    unittest.main()
