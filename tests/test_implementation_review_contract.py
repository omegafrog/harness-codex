from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ImplementationReviewContractTests(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_wrapper_requires_two_axis_review_after_implementation(self):
        wrapper = self.read(".codex/skills/implement-wrapper/SKILL.md")
        implement = self.read(".codex/skills/implement/SKILL.md")

        for text in (wrapper, implement):
            self.assertIn("fixed point", text)
            self.assertIn("standards_reviewer", text)
            self.assertIn("spec_reviewer", text)
            self.assertIn("Product Spec", text)
            self.assertIn("Architecture Spec", text)
            self.assertIn("both", text)

    def test_review_axes_map_to_product_then_architecture(self):
        review = self.read(".codex/skills/code-review/SKILL.md")
        standards = self.read(".codex/agents/standards_reviewer.toml")
        spec = self.read(".codex/agents/spec_reviewer.toml")

        self.assertIn("Standards: does the implementation satisfy the ticket-scoped Product Spec?", review)
        self.assertIn("Spec: does the implementation satisfy the ticket-scoped Architecture Spec?", review)
        self.assertIn("Product Spec", standards)
        self.assertIn("Architecture Spec", spec)

    def test_code_review_requires_real_isolated_subagents(self):
        review = self.read(".codex/skills/code-review/SKILL.md")

        self.assertIn("multi_agent_v1.spawn_agent", review)
        self.assertIn('agent_type="standards_reviewer"', review)
        self.assertIn('agent_type="spec_reviewer"', review)
        self.assertIn("fork_context: false", review)
        self.assertIn("Never invent reviewer IDs", review)
        self.assertIn("Never perform either reviewer pass inline", review)

    def test_code_review_eval_fixture_exercises_real_isolation_and_both_specs(self):
        case = self.read("evals/cases/code-review-isolation.yaml")
        product = self.read("evals/fixtures/code-review-isolation/docs/specs/496/product-spec.md")
        architecture = self.read("evals/fixtures/code-review-isolation/docs/specs/496/architecture-spec.md")
        diff = self.read("evals/fixtures/code-review-isolation/change.diff")

        self.assertIn("two actual isolated read-only subagents", case)
        self.assertIn("standards_reviewer", case)
        self.assertIn("spec_reviewer", case)
        self.assertIn("fork_context false", case)
        self.assertIn("do not invent reviewer/context IDs", case)
        self.assertNotIn("without asking a follow-up question or calling collaboration tools", case)
        self.assertIn('returns exactly `"after"`', product)
        self.assertIn("GREETING_MESSAGE", architecture)
        self.assertIn('+  return "after";', diff)


if __name__ == "__main__":
    unittest.main()
