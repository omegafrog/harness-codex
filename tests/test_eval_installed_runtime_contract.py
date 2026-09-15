from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class EvalInstalledRuntimeContractTests(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_latency_cap_does_not_drive_process_kill_timeout(self):
        runner = self.read("src/eval/runner.mjs")

        self.assertIn("timeoutMs: config.eval.default_case_timeout_ms || null", runner)
        self.assertNotIn("timeoutMs: caseSpec.hard_caps.max_latency_ms", runner)
        self.assertIn("latency_ms: execution.durationMs", runner)
        self.assertIn('cap: "max_latency_ms"', runner)
        self.assertIn('mode: "post_execution"', runner)

    def test_eval_process_ceiling_allows_real_subagent_waits(self):
        config = self.read(".codex/harness.yaml")
        loader = self.read("src/eval/case-loader.mjs")

        self.assertIn("default_case_timeout_ms: 300000", config)
        self.assertIn("default_case_timeout_ms: 300000", loader)

    def test_full_install_synchronizes_workflow_assets(self):
        installer = self.read("bin/harness-install.mjs")

        self.assertIn("const fullInstall = options.installSkills && options.installAgents", installer)
        self.assertIn("syncResult = await updateProject({ sourceRoot: packageRoot, targetRoot: projectRoot })", installer)
        self.assertIn('".codex/workflows/spec-me.yaml"', installer)
        self.assertIn('".codex/workflows/code-review.yaml"', installer)

    def test_partial_install_does_not_force_managed_runtime_sync(self):
        installer = self.read("bin/harness-install.mjs")

        self.assertIn("if (fullInstall)", installer)
        self.assertIn('arg === "--agents-only"', installer)
        self.assertIn('arg === "--skills-only"', installer)

    def test_source_policy_fixture_is_actually_settled(self):
        case = self.read("evals/cases/spec-me-source-policy.yaml")

        for expected in [
            "one local user",
            "Out of scope: accounts, multi-user collaboration, sync, priorities, due dates, tags, editing, and deletion",
            "blank text is rejected",
            "unknown ID or already-completed task returns an explicit error",
            "Persistence means tasks and completion state remain available after the CLI process exits",
            "stable requirement/use-case IDs",
        ]:
            self.assertIn(expected, case)


if __name__ == "__main__":
    unittest.main()
