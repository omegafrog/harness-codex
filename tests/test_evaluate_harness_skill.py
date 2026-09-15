from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class EvaluateHarnessSkillContractTest(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_skill_wraps_existing_eval_framework(self):
        skill = self.read(".codex/skills/evaluate-harness/SKILL.md")

        self.assertIn("name: evaluate-harness", skill)
        self.assertIn("node bin/harness-eval.mjs run --suite <suite-id>", skill)
        self.assertIn("evals/suites/*.yaml", skill)
        self.assertIn("result.json", skill)
        self.assertIn("report.json", skill)
        self.assertIn("suite's own `thresholds` and `baseline`", skill)

    def test_skill_supports_installed_consumer_mode(self):
        skill = self.read(".codex/skills/evaluate-harness/SKILL.md")

        self.assertIn("### Installed mode", skill)
        self.assertIn("do **not** fail merely because `evals/` or `bin/harness-eval.mjs` is absent", skill)
        self.assertIn("--package github:omegafrog/harness-codex", skill)
        self.assertIn("harness-eval run --suite <suite-id>", skill)
        self.assertIn("consumer repositories do not need copies", skill)
        self.assertIn("local Harness-source modifications", skill)

    def test_eval_cli_uses_its_package_root(self):
        cli = self.read("bin/harness-eval.mjs")

        self.assertIn("const packageRoot", cli)
        self.assertIn("fileURLToPath(import.meta.url)", cli)
        self.assertIn("runSuite({ root: packageRoot", cli)

    def test_skill_requires_full_eval_dimensions(self):
        skill = self.read(".codex/skills/evaluate-harness/SKILL.md")

        for expected in [
            "hard-gate failures",
            "critical-case pass rate",
            "overall pass rate",
            "mean quality",
            "p10 quality",
            "token regression",
            "latency regression",
            "inconclusive rate",
        ]:
            self.assertIn(expected, skill)

    def test_skill_has_safe_selection_retry_and_baseline_rules(self):
        skill = self.read(".codex/skills/evaluate-harness/SKILL.md")

        self.assertIn("run every available suite", skill)
        self.assertIn("run `p0` as the smoke/regression suite", skill)
        self.assertIn("Never claim full Harness coverage", skill)
        self.assertIn("Do not automatically retry ordinary `failed` cases", skill)
        self.assertIn("Never update a suite baseline just to make a failing run pass", skill)
        self.assertIn("explicit user approval", skill)


if __name__ == "__main__":
    unittest.main()
