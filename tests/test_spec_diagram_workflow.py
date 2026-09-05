from pathlib import Path
import re
import unittest


ROOT = Path(__file__).parents[1]


class SpecDiagramWorkflowContractTests(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text()

    def test_plantuml_skill_defines_local_renderer_contract_and_rules(self):
        skill = self.read(".codex/skills/plantuml-diagrams/SKILL.md")

        for phrase in (
            "bin/plantuml-render.mjs",
            "bin/plantuml-bootstrap.mjs",
            ".puml",
            "SVG",
            "!include",
            "workspace 밖",
            "원격",
            "렌더 실패",
        ):
            self.assertIn(phrase, skill)

    def test_product_contract_is_flow_conditional_and_excludes_classes(self):
        skill = self.read(".codex/skills/product-spec/SKILL.md")
        template = self.read(".codex/skills/product-spec/references/template.md")

        for text in (skill, template):
            self.assertRegex(text, r"흐름.*(신설|변경).*(유스케이스|액티비티)")
            self.assertIn("업무 상태", text)
            self.assertIn("클래스", text)
            self.assertIn("다이어그램", text)
            self.assertIn("SVG", text)

        self.assertRegex(skill, r"클래스.*(생성|금지|만들지)\s*(하지|금지|않)")

    def test_architecture_contract_has_independent_diagrams_and_links(self):
        skill = self.read(".codex/skills/architecture-spec/SKILL.md")
        template = self.read(".codex/skills/architecture-spec/references/template.md")

        for text in (skill, template):
            self.assertIn("독립", text)
            self.assertIn(".puml", text)
            self.assertIn("SVG", text)
            self.assertIn("architecture", text)
            self.assertIn("클래스", text)
            self.assertIn("설계 상태", text)

    def test_spec_me_blocks_stage_completion_until_diagram_gate_passes(self):
        skill = self.read(".codex/skills/spec-me/SKILL.md")

        self.assertRegex(skill, r"다이어그램.*완료.*게이트|완료.*게이트.*다이어그램")
        self.assertIn("원본", skill)
        self.assertIn("렌더", skill)
        self.assertIn("Markdown", skill)
        self.assertIn("일치", skill)
        self.assertIn("렌더 실패", skill)

    def test_diagram_creation_is_delegated_to_lightweight_agent(self):
        skills = [
            self.read(".codex/skills/spec-me/SKILL.md"),
            self.read(".codex/skills/product-spec/SKILL.md"),
            self.read(".codex/skills/architecture-spec/SKILL.md"),
            self.read(".codex/skills/plantuml-diagrams/SKILL.md"),
        ]

        for skill in skills:
            self.assertIn("diagram_creator", skill)
        self.assertIn("경량", self.read(".codex/skills/spec-me/SKILL.md"))
        self.assertIn("model_reasoning_effort", self.read(".codex/agents/diagram_creator.toml"))

    def test_diagram_paths_ids_and_svg_links_are_canonical(self):
        texts = [
            self.read(".codex/skills/plantuml-diagrams/SKILL.md"),
            self.read(".codex/skills/product-spec/references/template.md"),
            self.read(".codex/skills/architecture-spec/references/template.md"),
        ]
        combined = "\n".join(texts)

        self.assertIn("docs/specs/<ticket-id>/diagrams/product", combined)
        self.assertIn("docs/specs/<ticket-id>/diagrams/architecture", combined)
        self.assertRegex(combined, r"UC-<id>|UC-001")
        self.assertRegex(combined, r"\.puml.*\.svg|\.svg.*\.puml")
        self.assertRegex(combined, r"요구사항.*ID|유스케이스.*ID")

    def test_gh_open_pr_uses_local_eli5_and_plantuml_preview_contract(self):
        skill = self.read(".codex/skills/gh-open-pr/SKILL.md")

        self.assertIn(".codex/skills/eli5/SKILL.md", skill)
        self.assertRegex(skill, r"한 문장.*최대 세 단계|최대 세 단계.*한 문장")
        self.assertIn("Before → After", skill)
        self.assertIn("<details>", skill)
        self.assertRegex(skill, r"ID.*이름.*유형|이름.*유형.*ID")
        self.assertIn("../blob/<head-branch>/", skill)
        self.assertIn("?raw=true", skill)
        self.assertIn("PlantUML SVG", skill)
        self.assertNotIn("Include a Mermaid diagram", skill)
        self.assertNotIn("```mermaid", skill)

    def test_gh_open_pr_keeps_optional_plan_diagram_links(self):
        skill = self.read(".codex/skills/gh-open-pr/SKILL.md")

        self.assertIn("only available, non-empty", skill)
        self.assertIn("해당 없음", skill)
        self.assertIn("continue the plan PR without blocking it", skill)
        self.assertIn("링크를 생략하고", skill)
        self.assertIn("Never add a closing trigger to a plan PR", skill)

    def test_spec_workflow_promotes_durable_vocabulary_to_context_docs(self):
        domain = self.read(".codex/skills/domain-modeling/SKILL.md")
        grill = self.read(".codex/skills/grill-with-docs/SKILL.md")
        product = self.read(".codex/skills/product-spec/SKILL.md")
        architecture = self.read(".codex/skills/architecture-spec/SKILL.md")

        self.assertIn("Project-wide canonical terms", domain)
        self.assertIn("CONTEXT-MAP.md", domain)
        self.assertIn("Spec terminology table is evidence", domain)
        self.assertIn("Update `CONTEXT.md`", grill)
        self.assertIn("Durable vocabulary", grill)
        self.assertIn("promote settled project-wide", product)
        self.assertIn("CONTEXT-MAP.md", architecture)

    def test_user_managed_architecture_constraints_are_loaded(self):
        constraints = self.read("docs/architecture/constraints.md")
        architecture = self.read(".codex/skills/architecture-spec/SKILL.md")
        implement = self.read(".codex/skills/implement/SKILL.md")
        review = self.read(".codex/skills/code-review/SKILL.md")

        self.assertIn("component scan", constraints)
        self.assertIn("@Bean", constraints)
        self.assertIn("docs/architecture/constraints.md", architecture)
        self.assertIn("docs/architecture/constraints.md", implement)
        self.assertIn("docs/architecture/constraints.md", review)


if __name__ == "__main__":
    unittest.main()
