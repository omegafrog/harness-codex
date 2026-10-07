from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class KnowledgeIntegrationContractTest(unittest.TestCase):
    def test_spec_me_uses_approved_principles_read_only_and_holds_without_authority(self):
        spec_me = (ROOT / ".codex/skills/spec-me/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("read-only registry contract", spec_me)
        self.assertIn("Only hash-valid `approved` Principles are authoritative", spec_me)
        self.assertIn("Do not create, revise, approve, or deprecate Principles from `spec-me`", spec_me)
        self.assertIn("keep the Decision on hold", spec_me)

    def test_architecture_and_planner_handoffs_keep_all_accepted_reference_ids(self):
        architecture = (ROOT / ".codex/skills/architecture-spec/SKILL.md").read_text(encoding="utf-8")
        to_ticket = (ROOT / ".codex/skills/to-ticket/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("accepted Decision, target, Principle, and Evidence IDs", architecture)
        self.assertIn("approved durable Evidence", architecture)
        self.assertIn("base/ours/theirs", architecture)
        self.assertIn("approved durable Evidence 참조", to_ticket)
        self.assertIn("표식이 없으면 두 gate는 기존 계획 계약을 그대로 허용", to_ticket)

    def test_deprecated_reference_requires_review_without_changing_history(self):
        spec_me = (ROOT / ".codex/skills/spec-me/SKILL.md").read_text(encoding="utf-8")
        architecture = (ROOT / ".codex/skills/architecture-spec/SKILL.md").read_text(encoding="utf-8")
        self.assertIn("review_required", spec_me)
        self.assertIn("approval and history preserved", spec_me)
        self.assertIn("review-required while preserving their prior approval and history", architecture)


if __name__ == "__main__":
    unittest.main()
