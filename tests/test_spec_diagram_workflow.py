from pathlib import Path
import re
import unittest


ROOT = Path(__file__).parents[1]


class SpecDiagramWorkflowContractTests(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text()

    def test_plantuml_skill_defines_local_renderer_contract_and_rules(self):
        skill = self.read(".codex/internal-skills/plantuml-diagrams/GUIDE.md")

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
        skill = self.read(".codex/internal-skills/product-spec/GUIDE.md")
        template = self.read(".codex/internal-skills/product-spec/references/template.md")

        for text in (skill, template):
            self.assertRegex(text, r"흐름.*(신설|변경).*(유스케이스|액티비티)")
            self.assertIn("업무 상태", text)
            self.assertIn("클래스", text)
            self.assertIn("다이어그램", text)
            self.assertIn("SVG", text)

        self.assertRegex(skill, r"클래스.*(생성|금지|만들지)\s*(하지|금지|않)")

    def test_architecture_contract_has_independent_diagrams_and_links(self):
        skill = self.read(".codex/internal-skills/architecture-spec/GUIDE.md")
        template = self.read(".codex/internal-skills/architecture-spec/references/template.md")

        for text in (skill, template):
            self.assertIn("독립", text)
            self.assertIn(".puml", text)
            self.assertIn("SVG", text)
            self.assertIn("architecture", text)
            self.assertIn("클래스", text)
            self.assertIn("설계 상태", text)

    def test_class_diagrams_preserve_code_signatures_and_symbols(self):
        texts = [
            self.read(".codex/internal-skills/plantuml-diagrams/GUIDE.md"),
            self.read(".codex/agents/diagram_creator.toml"),
            self.read(".codex/internal-skills/architecture-spec/references/template.md"),
        ]

        for text in (texts[0], texts[2]):
            self.assertIn("클래스 다이어그램", text)
            self.assertIn("메서드", text)
            self.assertIn("변수", text)
            self.assertIn("상수", text)
            self.assertIn("시그니처", text)
            self.assertIn("심볼", text)
            self.assertRegex(text, r"번역하지|변환하지|원문.*그대로")

        agent = texts[1]
        self.assertIn("For class diagrams", agent)
        for term in ("methods", "variables", "constants", "full signatures", "symbols"):
            self.assertIn(term, agent)
        self.assertIn("Do not translate", agent)

    def test_spec_me_blocks_stage_completion_until_diagram_gate_passes(self):
        product = self.read(".codex/internal-skills/product-spec/GUIDE.md")
        architecture = self.read(".codex/internal-skills/architecture-spec/GUIDE.md")
        stages = "\n".join((product, architecture))

        self.assertRegex(stages, r"diagram gate|다이어그램.*완료.*게이트|완료.*게이트.*다이어그램")
        self.assertIn(".puml", stages)
        self.assertIn("SVG", stages)
        self.assertIn("Markdown", stages)
        self.assertIn("content-consistency", stages)
        self.assertIn("render failure", stages)

    def test_spec_me_prepares_the_session_worktree_before_spawning_agents(self):
        skill = self.read(".codex/skills/spec-me/SKILL.md")
        router = self.read(".codex/internal-skills/session-worktree/GUIDE.md")
        create = self.read(".codex/internal-skills/worktree-create/GUIDE.md")
        cli = self.read(".codex/internal-skills/session-worktree/references/worktree-cli.md")
        execution = self.read("docs/agents/EXEC.md")

        for name in ("sequential", "parallel"):
            self.assertIn(f"references/{name}.md", router)
        self.assertNotIn("harness-workflow-worktree.mjs create", router)
        self.assertIn("harness-workflow-worktree.mjs create --root", cli)
        self.assertIn("harness-workflow-worktree.mjs finish", cli)
        self.assertNotIn("harness-workflow-worktree.mjs create", execution)
        self.assertIn("worktree-create", skill)
        self.assertIn("internal-skills/product-spec/GUIDE.md", skill)
        self.assertIn("references/architecture-decision.md", skill)
        self.assertIn("harness-workflow-worktree.mjs create --root", create)
        self.assertIn("harness-workspace-preflight.mjs --workspace-root", create)
        self.assertIn("<session_directory>/worktree.json", create)
        self.assertIn("source_workspace", cli)
        self.assertIn("CLI가 발급한 실행 ID", cli)
        self.assertIn("<session_directory>/worktree.json", create)

    def test_diagram_creation_is_delegated_to_lightweight_agent(self):
        skills = [
            self.read(".codex/skills/spec-me/SKILL.md"),
            self.read(".codex/internal-skills/product-spec/GUIDE.md"),
            self.read(".codex/internal-skills/architecture-spec/GUIDE.md"),
            self.read(".codex/internal-skills/plantuml-diagrams/GUIDE.md"),
        ]

        for skill in skills:
            self.assertIn("diagram_creator", skill)
        delegated_spec = "\n".join(skills[:3])
        self.assertIn("lightweight spawn", skills[0])
        self.assertIn("multi_agent_v1.spawn_agent", delegated_spec)
        self.assertIn('agent_type="diagram_creator"', delegated_spec)
        self.assertIn("fork_context: false", delegated_spec)
        self.assertIn("model_reasoning_effort", self.read(".codex/agents/diagram_creator.toml"))

    def test_diagram_paths_ids_and_svg_links_are_canonical(self):
        texts = [
            self.read(".codex/internal-skills/plantuml-diagrams/GUIDE.md"),
            self.read(".codex/internal-skills/product-spec/references/template.md"),
            self.read(".codex/internal-skills/architecture-spec/references/template.md"),
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
        domain = self.read(".codex/internal-skills/domain-modeling/GUIDE.md")
        grill = self.read(".codex/internal-skills/grill-with-docs/GUIDE.md")
        product = self.read(".codex/internal-skills/product-spec/GUIDE.md")
        architecture = self.read(".codex/internal-skills/architecture-spec/GUIDE.md")

        self.assertIn("Project-wide canonical terms", domain)
        self.assertIn("CONTEXT-MAP.md", domain)
        self.assertIn("Spec terminology table is evidence", domain)
        self.assertIn("Update `CONTEXT.md`", grill)
        self.assertIn("Durable vocabulary", grill)
        self.assertIn("promote settled project-wide", product)
        self.assertIn("CONTEXT-MAP.md", architecture)

    def test_user_managed_architecture_constraints_are_loaded(self):
        constraints = self.read("docs/architecture/constraints.md")
        architecture = self.read(".codex/internal-skills/architecture-spec/GUIDE.md")
        implement = self.read(".codex/internal-skills/implement/GUIDE.md")
        review = self.read(".codex/skills/code-review/SKILL.md")

        self.assertIn("component scan", constraints)
        self.assertIn("@Bean", constraints)
        self.assertIn("docs/architecture/constraints.md", architecture)
        self.assertIn("docs/architecture/constraints.md", implement)
        self.assertIn("docs/architecture/constraints.md", review)


if __name__ == "__main__":
    unittest.main()
