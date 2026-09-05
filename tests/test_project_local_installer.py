from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "bin" / "harness-install.mjs"


class ProjectLocalInstallerTest(unittest.TestCase):
    def run_installer(self, target: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "node",
                str(INSTALLER),
                "install",
                "--project",
                str(target),
                "--agents-only",
                *args,
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_installs_all_agent_profiles_project_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)

            result = self.run_installer(target)

            self.assertEqual(result.returncode, 0, result.stderr)
            agents = target / ".codex" / "agents"
            self.assertEqual(
                {path.name for path in agents.glob("*.toml")},
                {
                    "code_researcher.toml",
                    "diagram_creator.toml",
                    "spec_reviewer.toml",
                    "standards_reviewer.toml",
                },
            )
            for path in agents.glob("*.toml"):
                data = tomllib.loads(path.read_text(encoding="utf-8"))
                self.assertNotIn("model", data)
                self.assertNotIn(".codex/skills/", data["developer_instructions"])
                self.assertIn(".agents/skills/", data["developer_instructions"])

    def test_preserves_existing_profile_without_force(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            profile = target / ".codex" / "agents" / "spec_reviewer.toml"
            profile.parent.mkdir(parents=True)
            profile.write_text("user-owned\n", encoding="utf-8")

            result = self.run_installer(target)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(profile.read_text(encoding="utf-8"), "user-owned\n")
            self.assertIn("Skipped existing agents: spec_reviewer.toml", result.stdout)

    def test_force_overwrites_existing_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            profile = target / ".codex" / "agents" / "spec_reviewer.toml"
            profile.parent.mkdir(parents=True)
            profile.write_text("user-owned\n", encoding="utf-8")

            result = self.run_installer(target, "--force")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotEqual(profile.read_text(encoding="utf-8"), "user-owned\n")


if __name__ == "__main__":
    unittest.main()
