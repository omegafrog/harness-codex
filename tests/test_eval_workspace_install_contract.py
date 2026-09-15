from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class EvalWorkspaceInstallContractTests(unittest.TestCase):
    def read(self, relative: str) -> str:
        return (ROOT / relative).read_text(encoding="utf-8")

    def test_case_workspace_uses_real_harness_installer(self):
        workspace = self.read("src/eval/case-workspace.mjs")

        self.assertIn('resolve(root, "bin/harness-install.mjs")', workspace)
        self.assertIn('[installerPath, "install", "--project", workspace, "--force"]', workspace)
        self.assertIn('await installHarnessRuntime({ root, workspace: stagingWorkspace })', workspace)
        self.assertNotIn("copyHarnessRuntime", workspace)
        self.assertNotIn('directory === ".codex/skills" ? ".agents/skills"', workspace)

    def test_workspace_is_git_repo_before_install(self):
        workspace = self.read("src/eval/case-workspace.mjs")

        git_init = workspace.index('await execFileAsync("git", ["init", "-q", stagingWorkspace])')
        install = workspace.index('await installHarnessRuntime({ root, workspace: stagingWorkspace })')
        baseline_commit = workspace.index('"eval fixture baseline"')

        self.assertLess(git_init, install)
        self.assertLess(install, baseline_commit)

    def test_eval_config_is_seeded_without_replacing_installer_behavior(self):
        workspace = self.read("src/eval/case-workspace.mjs")

        self.assertIn("normal installer", workspace)
        self.assertIn("intentionally leaves project-specific .codex/harness.yaml creation to $setup", workspace)
        self.assertIn('resolve(root, ".codex/harness.yaml")', workspace)


if __name__ == "__main__":
    unittest.main()
