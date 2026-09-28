from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
FIGMA = ROOT / ".codex" / "skills" / "frontend-figma" / "SKILL.md"
DESIGN = ROOT / ".codex" / "skills" / "frontend-design" / "SKILL.md"
IMPLEMENT = ROOT / ".codex" / "skills" / "frontend-implement" / "SKILL.md"
REVIEW = ROOT / ".codex" / "skills" / "frontend-visual-review" / "SKILL.md"


class FrontendFigwrightContractTest(unittest.TestCase):
    def test_figwright_adapter_owns_figma_bridge(self):
        text = FIGMA.read_text(encoding="utf-8")

        for required in (
            "Figwright",
            "ping",
            "list_files",
            "use_file",
            "get_design_context",
            "component_map",
            "token_map",
            "icon_map",
            "get_screenshot",
            "design_diff",
            "figma-build",
            "figma-codegen",
        ):
            self.assertIn(required, text)

        self.assertIn("Figma Agent / Figma Make", text)
        self.assertIn("Figma write는 design 단계에서만 수행", text)
        self.assertIn("visual reviewer는 Figma와 application source를 수정하지 않는다", text)

    def test_frontend_workflow_passes_one_figma_root_through_all_stages(self):
        design = DESIGN.read_text(encoding="utf-8")
        implement = IMPLEMENT.read_text(encoding="utf-8")
        review = REVIEW.read_text(encoding="utf-8")

        self.assertIn("frontend-figma", design)
        self.assertIn("authoritative root frame/node id", design)
        self.assertIn("Mode B", implement)
        self.assertIn("get_design_context", implement)
        self.assertIn("Mode C", review)
        self.assertIn("Figma evidence", review)


if __name__ == "__main__":
    unittest.main()
