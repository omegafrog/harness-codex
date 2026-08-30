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

    def test_follow_up_plan_preserves_unmerged_predecessor_lineage(self):
        self.assertRegex(
            self.to_ticket,
            r"(?is)(follow-up|continuation).{0,400}(unmerged|open PR).{0,400}(current branch|predecessor branch).{0,400}(base ref|base branch)",
        )

    def test_default_branch_is_used_only_without_unmerged_predecessor(self):
        self.assertRegex(
            self.to_ticket,
            r"(?is)(default branch|origin/main).{0,400}(only|when).{0,400}(no|without).{0,300}(unmerged|predecessor|continuation)",
        )

    def test_stacked_plan_pr_targets_predecessor_branch(self):
        self.assertRegex(
            self.gh_open_pr,
            r"(?is)(stacked|follow-up).{0,400}(predecessor|parent).{0,300}(base branch|--base)",
        )


if __name__ == "__main__":
    unittest.main()
