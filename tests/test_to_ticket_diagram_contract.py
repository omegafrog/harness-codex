from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ToTicketDiagramContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.to_ticket = (ROOT / ".codex/skills/to-ticket/SKILL.md").read_text(encoding="utf-8")
        cls.gh_open_pr = (ROOT / ".codex/skills/gh-open-pr/SKILL.md").read_text(encoding="utf-8")

    def test_diagram_links_are_optional_and_absence_is_explicit(self):
        self.assertIn("optional", self.to_ticket.lower())
        self.assertRegex(self.to_ticket, r"(?i)(다이어그램|diagram).*?(링크|link)")
        self.assertRegex(self.to_ticket, r"해당 없음.*(차단|선행 조건|분할)")
        self.assertRegex(self.to_ticket, r"다이어그램.*(부재|없).*?(차단|선행 조건)")

    def test_child_plan_preserves_contract_and_links_only_available_artifacts(self):
        self.assertRegex(self.to_ticket, r"child Issue.*(목적|purpose)")
        self.assertRegex(self.to_ticket, r"(수용 기준|acceptance criteria).*(테스트 계약|test contract)")
        self.assertRegex(self.to_ticket, r"(존재|available).*?(다이어그램|diagram).*?(링크|link)")
        self.assertRegex(self.to_ticket, r"(없으면|부재).*?(생략|omit|기록)")

    def test_plan_pr_links_use_head_branch_and_keep_no_diagram_valid(self):
        self.assertRegex(self.to_ticket, r"draft plan PR.*(다이어그램|diagram)")
        self.assertRegex(self.gh_open_pr, r"<head-branch>/.+\.svg\?raw=true")
        self.assertRegex(self.gh_open_pr, r"(available|존재).*?(다이어그램|diagram).*?(link|링크)")
        self.assertRegex(self.gh_open_pr, r"(없으면|부재).*?(생략|omit|해당 없음)")
        self.assertIn("Never add a closing trigger to a plan PR", self.gh_open_pr)


if __name__ == "__main__":
    unittest.main()
