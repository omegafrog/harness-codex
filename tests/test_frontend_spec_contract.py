from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / ".codex" / "skills" / "frontend-spec" / "SKILL.md"
DESIGN = ROOT / ".codex" / "skills" / "frontend-design" / "SKILL.md"


class FrontendSpecContractTest(unittest.TestCase):
    def test_frontend_spec_produces_three_document_package(self):
        text = SPEC.read_text(encoding="utf-8")

        for required in (
            "docs/design/<screen-id>/",
            "frontend-design-spec.md",
            "visual-direction.md",
            "ui-contract.md",
            "Primary reference",
            "Supporting reference",
            "Anti-reference",
            "Storybook coverage contract",
            "Figma mapping contract",
        ):
            self.assertIn(required, text)

    def test_frontend_spec_stops_before_figma_and_code(self):
        text = SPEC.read_text(encoding="utf-8")

        self.assertIn("Figma를 작성하지 않는다", text)
        self.assertIn("application source를 수정하지 않는다", text)
        self.assertIn("Storybook story를 구현하지 않는다", text)
        self.assertIn("material `UNRESOLVED`가 없다", text)

    def test_frontend_design_consumes_ready_package_without_redesign(self):
        text = DESIGN.read_text(encoding="utf-8")

        self.assertIn("Frontend Design Package contract", text)
        self.assertIn("authoritative design input", text)
        self.assertIn("같은 reference research를 처음부터 반복하지 않는다", text)
        self.assertIn("frontend-spec", text)


if __name__ == "__main__":
    unittest.main()
