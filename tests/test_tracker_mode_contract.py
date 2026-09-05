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

    def test_github_mode_keeps_plans_index_without_making_it_status_source(self):
        to_ticket = (ROOT / ".codex" / "skills" / "to-ticket" / "SKILL.md").read_text(encoding="utf-8")
        plan_status = (ROOT / "docs" / "agents" / "plan-status.md").read_text(encoding="utf-8")
        wrapper = (ROOT / ".codex" / "skills" / "implement-wrapper" / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("docs/plans/<plan-set-id>/plans.md", to_ticket)
        self.assertNotIn("docs/plans/plans.md", to_ticket)
        self.assertIn("generated navigation/index", to_ticket)
        self.assertIn("상태 source가 아니다", plan_status)
        self.assertIn("when present", wrapper)

    def test_repository_has_no_triage_contract(self):
        self.assertFalse((ROOT / "docs" / "agents" / "triage-labels.md").exists())
        self.assertFalse((ROOT / "docs" / "adr" / "0001-triage-label-vocabulary.md").exists())

    def test_github_assignee_rules_are_explicit(self):
        config = (ROOT / ".codex" / "harness.yaml").read_text(encoding="utf-8")
        issue_tracker = (ROOT / "docs" / "agents" / "issue-tracker.md").read_text(encoding="utf-8")
        to_ticket = (ROOT / ".codex" / "skills" / "to-ticket" / "SKILL.md").read_text(encoding="utf-8")
        implement = (ROOT / ".codex" / "skills" / "implement" / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("assignees:", config)
        self.assertIn('spec_me: "@me"', config)
        self.assertIn('codex: "@copilot"', config)
        self.assertIn("spec-me → to-ticket", issue_tracker)
        self.assertIn('`@me`', to_ticket)
        self.assertIn("SPEC_ME_ASSIGNEE", to_ticket)
        self.assertIn('--assignee "$SPEC_ME_ASSIGNEE"', to_ticket)
        self.assertIn("CODEX_ASSIGNEE", implement)
        self.assertIn('--assignee "$CODEX_ASSIGNEE"', implement)
        self.assertIn("기존 Issue의 assignee는 명시적 요청 없이 변경하지 않는다", implement)

    def test_implementation_pr_closes_parent_and_children_only_after_merge(self):
        gh_open_pr = (ROOT / ".codex" / "skills" / "gh-open-pr" / "SKILL.md").read_text(encoding="utf-8")
        implement = (ROOT / ".codex" / "skills" / "implement" / "SKILL.md").read_text(encoding="utf-8")
        wrapper = (ROOT / ".codex" / "skills" / "implement-wrapper" / "SKILL.md").read_text(encoding="utf-8")
        plan_status = (ROOT / "docs" / "agents" / "plan-status.md").read_text(encoding="utf-8")

        self.assertIn("parent Issue와 모든 child Issue", gh_open_pr)
        self.assertIn("plan-set implementation PR", gh_open_pr)
        self.assertIn("child-scoped implementation PR", gh_open_pr)
        self.assertIn("Closes #<PARENT-ISSUE-NUMBER>", gh_open_pr)
        self.assertIn("Closes #<CHILD-ISSUE-NUMBER>", gh_open_pr)
        self.assertIn("repository default branch", gh_open_pr)
        self.assertIn("구현 완료만으로 child Issue를 닫지 않는다", implement)
        self.assertIn("PR merge", implement)
        self.assertNotIn("sets the child Issue's Project `Workflow Status` to `Done` and closes", implement)
        self.assertIn("Project `Workflow Status` is `Done`", implement)
        self.assertIn("After a completed plan's implementation PR merges, verify the intended parent/child Issues are closed", wrapper)
        self.assertIn("Project status is `Done`", wrapper)
        self.assertIn("keep the child Issue open", wrapper)
        self.assertNotIn("After completion, `implement` recalculates dependent tickets", wrapper)
        self.assertIn("merge 후", plan_status)


if __name__ == "__main__":
    unittest.main()
