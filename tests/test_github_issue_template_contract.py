from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / ".codex" / "skills" / "to-ticket" / "references" / "github-issue-template.md"
TO_TICKET = ROOT / ".codex" / "skills" / "to-ticket" / "SKILL.md"


class GithubIssueTemplateContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template = TEMPLATE.read_text(encoding="utf-8")
        cls.skill = TO_TICKET.read_text(encoding="utf-8")

    def test_template_defines_distinct_parent_and_child_formats(self):
        self.assertIn("## Parent Issue", self.template)
        self.assertIn("## Child Issue", self.template)
        self.assertIn("필수: `Plan Set`, `목적`, `실행 순서`, `명세와 다이어그램`, `의존성`, `검증`", self.template)
        for heading in ("상태", "의존성", "구현 목적", "범위", "수용 기준", "테스트 계약", "관련 명세", "다이어그램"):
            self.assertIn(f"`{heading}`", self.template)

    def test_template_forbids_unvalidated_mutation(self):
        self.assertIn("생성 전 검증", self.template)
        self.assertIn("placeholder", self.template)
        self.assertIn("GitHub mutation을 중단", self.template)
        self.assertIn("validate each rendered body against the template", self.skill)
        self.assertIn("Validate rendered bodies before any GitHub mutation", self.skill)

    def test_child_contract_keeps_diagram_absence_non_blocking(self):
        self.assertIn("해당 없음 — 이유", self.template)
        self.assertRegex(self.template, r"다이어그램이 없으면.*링크를 생략")
        self.assertIn("다이어그램이 없으면 링크를 생략", self.skill)

    def test_github_mode_creates_real_sub_issues(self):
        self.assertIn("gh issue create --parent", self.skill)
        self.assertIn("gh issue edit <PARENT-ISSUE-NUMBER> --add-sub-issue", self.skill)
        self.assertIn("gh issue view <PARENT-ISSUE-NUMBER> --json subIssues", self.skill)
        self.assertIn("gh issue view <CHILD-ISSUE-NUMBER> --json parent", self.skill)
        self.assertIn("gh issue edit <CHILD-ISSUE-NUMBER> --parent <PARENT-ISSUE-NUMBER>", self.skill)
        self.assertIn("parent/child 관계를 Markdown 링크만으로 대체하지 않는다", self.skill)

    def test_parent_contract_requires_specs_and_rendered_svg_diagrams(self):
        self.assertIn("## 명세와 다이어그램", self.template)
        self.assertIn("Product Spec", self.template)
        self.assertIn("Architecture Spec", self.template)
        self.assertIn("![", self.template)
        self.assertIn("SVG", self.template)
        self.assertNotIn("```plantuml", self.template)
        self.assertIn("PlantUML", self.skill)
        self.assertIn("SVG 이미지", self.skill)
        self.assertIn("PlantUML 원문을 Issue body에 넣지 않는다", self.skill)
        self.assertIn("test -s <path>", self.skill)
        self.assertIn("<ticket-id>", self.skill)


if __name__ == "__main__":
    unittest.main()
