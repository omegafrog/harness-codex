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


if __name__ == "__main__":
    unittest.main()
