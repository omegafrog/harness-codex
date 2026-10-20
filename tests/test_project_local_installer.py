from pathlib import Path
import subprocess
import tempfile
import tomllib
import unittest
import json
import os


ROOT = Path(__file__).resolve().parents[1]
INSTALLER = ROOT / "bin" / "harness-install.mjs"
INSTALLER_STUBS = ROOT / "tests" / "fixtures" / "installer-stubs"


class ProjectLocalInstallerTest(unittest.TestCase):
    def command_env(self, signoz_mode: str | None = None, call_log: Path | None = None) -> dict[str, str]:
        env = {**os.environ, "PATH": f"{INSTALLER_STUBS}{os.pathsep}{os.environ['PATH']}"}
        if signoz_mode:
            env["CODEX_SIGNOZ_MODE"] = signoz_mode
        if call_log:
            env["CODEX_CALL_LOG"] = str(call_log)
        return env

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
            env=self.command_env(),
        )

    def run_full_installer(self, target: Path, signoz_mode: str | None = None, call_log: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", str(INSTALLER), "install", "--project", str(target)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            env=self.command_env(signoz_mode, call_log),
        )

    def run_update(self, target: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", str(INSTALLER), "update", "--project", str(target), *args],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            env=self.command_env(),
        )

    def run_doctor(self, target: Path) -> dict:
        result = subprocess.run(
            ["node", str(ROOT / "bin" / "harness-doctor.mjs"), "--project", str(target), "--json"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        report = json.loads(result.stdout)
        self.assertEqual(result.returncode, 0 if report["passed"] else 1, result.stdout + result.stderr)
        return report

    def configure_target(self, target: Path) -> None:
        config = target / ".codex" / "harness.yaml"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(
            "tracker:\n  mode: local-markdown\neval:\n  environment_profiles:\n    default:\n      permission_profile: eval-workspace\n      sandbox: workspace-write\n      network: restricted\n",
            encoding="utf-8",
        )

    def test_installs_all_agent_profiles_project_locally(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)

            result = self.run_installer(target)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("SigNoz Codex marketplace registered", result.stdout)
            agents = target / ".codex" / "agents"
            self.assertEqual(
                {path.name for path in agents.glob("*.toml")},
                {
                    "code_researcher.toml",
                    "architecture_review_lead.toml",
                    "diagram_creator.toml",
                    "spec_reviewer.toml",
                    "standards_reviewer.toml",
                    "spec_document_writer.toml",
                    "execution_runner.toml",
                    "e2e_test_runner.toml",
                    "implementation_agent.toml",
                    "to_ticket.toml",
                    "frontend_designer.toml",
                    "frontend_implementation_agent.toml",
                    "frontend_visual_reviewer.toml",
                    "knowledge_source_researcher.toml",
                    "knowledge_claim_extractor.toml",
                    "knowledge_principle_synthesizer.toml",
                    "knowledge_principle_reviewer.toml",
                    "spec_adversarial_reviewer.toml",
                    "human_approver.toml",
                },
            )
            for path in agents.glob("*.toml"):
                data = tomllib.loads(path.read_text(encoding="utf-8"))
                self.assertNotIn("model", data)
                self.assertNotIn(".codex/skills/", data["developer_instructions"])
                self.assertIn(".agents/skills/", data["developer_instructions"])
            lock = json.loads((target / ".codex" / "harness-lock.json").read_text(encoding="utf-8"))
            self.assertIn(".codex/agents/code_researcher.toml", lock["files"])
            status = subprocess.run(["git", "-C", str(target), "status", "--short"], text=True, capture_output=True, check=True)
            self.assertEqual(status.stdout, "")
            exclude = (target / ".git" / "info" / "exclude").read_text(encoding="utf-8")
            self.assertIn(".codex/", exclude)
            self.assertIn("skills-lock.json", exclude)

    def test_full_install_includes_project_local_workspace_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)
            self.configure_target(target)

            result = self.run_full_installer(target)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Project readiness: blocked (project_preparation_required)", result.stdout)
            self.assertIn("Required preparation:", result.stdout)
            report = self.run_doctor(target)
            self.assertFalse(report["passed"])
            self.assertTrue(any(item["code"] == "project_preparation_required" for item in report["diagnostics"]))
            self.assertFalse(any(item["code"] in {"installer_unlocked_file", "installer_stale_lock_entry"} for item in report["diagnostics"]))
            preflight = target / ".codex" / "scripts" / "harness-workspace-preflight.mjs"
            self.assertTrue(preflight.is_file())
            plans_gate = target / ".codex" / "scripts" / "plans-index-gate.mjs"
            self.assertTrue(plans_gate.is_file())
            self.assertTrue((target / ".codex" / "agents" / "architecture_review_lead.toml").is_file())
            self.assertTrue((target / ".agents" / "skills" / "architecture-review" / "SKILL.md").is_file())
            self.assertTrue((target / ".agents" / "skills" / "knowledge-harvest" / "SKILL.md").is_file())
            self.assertTrue((target / ".codex" / "agents" / "knowledge_source_researcher.toml").is_file())
            self.assertTrue((target / ".codex" / "agents" / "knowledge_claim_extractor.toml").is_file())
            self.assertTrue((target / ".codex" / "agents" / "knowledge_principle_synthesizer.toml").is_file())
            self.assertTrue((target / ".codex" / "agents" / "knowledge_principle_reviewer.toml").is_file())
            self.assertTrue((target / ".codex" / "agents" / "human_approver.toml").is_file())
            self.assertTrue((target / ".codex" / "workflows" / "knowledge-harvest-workflow.yaml").is_file())
            self.assertTrue((target / ".codex" / "scripts" / "harness-knowledge.mjs").is_file())
            self.assertTrue((target / ".codex" / "schemas" / "knowledge" / "source.schema.yaml").is_file())
            self.assertTrue((target / ".codex" / "schemas" / "knowledge" / "claim.schema.yaml").is_file())
            self.assertTrue((target / ".codex" / "schemas" / "knowledge" / "principle.schema.yaml").is_file())
            self.assertTrue((target / ".codex" / "schemas" / "knowledge" / "evidence.schema.yaml").is_file())
            locked_files = json.loads((target / ".codex" / "harness-lock.json").read_text(encoding="utf-8"))["files"]
            self.assertIn(".codex/scripts/harness-workspace-preflight.mjs", locked_files)
            self.assertIn(".codex/scripts/plans-index-gate.mjs", locked_files)
            for relative_path in [
                ".codex/agents/knowledge_source_researcher.toml",
                ".codex/agents/knowledge_claim_extractor.toml",
                ".codex/agents/knowledge_principle_synthesizer.toml",
                ".codex/agents/knowledge_principle_reviewer.toml",
                ".codex/agents/human_approver.toml",
                ".codex/workflows/knowledge-harvest-workflow.yaml",
                ".codex/scripts/harness-knowledge.mjs",
                ".codex/schemas/knowledge/source.schema.yaml",
                ".codex/schemas/knowledge/claim.schema.yaml",
                ".codex/schemas/knowledge/principle.schema.yaml",
                ".codex/schemas/knowledge/evidence.schema.yaml",
                ".agents/skills/knowledge-harvest/SKILL.md",
            ]:
                self.assertIn(relative_path, locked_files)

            arguments = ["node", str(plans_gate), "--workspace-root", str(target), "--plan-set-id", "plan-123"]
            missing = subprocess.run(arguments, text=True, capture_output=True, check=False)
            self.assertEqual(missing.returncode, 1)
            self.assertEqual(json.loads(missing.stdout)["reason"], "plans_index_missing")

            index = target / "docs" / "plans" / "plan-123" / "plans.md"
            index.parent.mkdir(parents=True)
            index.write_text("# Plans\n", encoding="utf-8")
            present = subprocess.run(arguments, text=True, capture_output=True, check=False)
            self.assertEqual(present.returncode, 0, present.stderr)
            self.assertEqual(json.loads(present.stdout)["status"], "pass")

    def test_full_install_reuses_registered_signoz_marketplace(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)
            self.configure_target(target)

            result = self.run_full_installer(target, "preinstalled")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("SigNoz Codex marketplace registered", result.stdout)

    def test_full_install_registers_signoz_marketplace(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)
            call_log = target / "codex.log"

            result = self.run_full_installer(target, call_log=call_log)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("plugin marketplace add SigNoz/agent-skills", call_log.read_text(encoding="utf-8"))

    def test_install_rejects_signoz_marketplace_name_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)

            result = self.run_full_installer(target, "conflict")

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("signoz-skills' already points to a different source", result.stderr)

    def test_preserves_existing_profile_without_force(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            profile = target / ".codex" / "agents" / "spec_reviewer.toml"
            profile.parent.mkdir(parents=True)
            profile.write_text("user-owned\n", encoding="utf-8")

            result = self.run_installer(target)

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(profile.read_text(encoding="utf-8"), "user-owned\n")
            self.assertIn(".codex/agents/spec_reviewer.toml (unlocked)", result.stdout)
            lock = json.loads((target / ".codex" / "harness-lock.json").read_text(encoding="utf-8"))
            self.assertNotIn(".codex/agents/spec_reviewer.toml", lock["files"])

    def test_force_overwrites_existing_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            profile = target / ".codex" / "agents" / "spec_reviewer.toml"
            profile.parent.mkdir(parents=True)
            profile.write_text("user-owned\n", encoding="utf-8")

            result = self.run_installer(target, "--force")

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotEqual(profile.read_text(encoding="utf-8"), "user-owned\n")
            self.assertIn("Local backups:", result.stdout)

    def test_update_preserves_local_skill_by_default_and_force_backs_it_up(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)
            self.configure_target(target)
            install = self.run_full_installer(target)
            self.assertEqual(install.returncode, 0, install.stderr)
            skill = target / ".agents" / "skills" / "spec-me" / "SKILL.md"
            upstream = (ROOT / ".codex" / "skills" / "spec-me" / "SKILL.md").read_text(encoding="utf-8")
            skill.write_text("local skill\n", encoding="utf-8")

            preserved = self.run_update(target)
            self.assertEqual(preserved.returncode, 0, preserved.stderr)
            self.assertEqual(skill.read_text(encoding="utf-8"), "local skill\n")

            forced = self.run_update(target, "--force")
            self.assertEqual(forced.returncode, 0, forced.stderr)
            self.assertEqual(skill.read_text(encoding="utf-8"), upstream)
            backup_line = next(line for line in forced.stdout.splitlines() if line.startswith("Local backups: "))
            backup = Path(backup_line.removeprefix("Local backups: ")) / ".agents" / "skills" / "spec-me" / "SKILL.md"
            self.assertEqual(backup.read_text(encoding="utf-8"), "local skill\n")
            report = self.run_doctor(target)
            self.assertFalse(report["passed"])
            self.assertTrue(any(item["code"] == "project_preparation_required" for item in report["diagnostics"]))
            self.assertFalse(any(item["code"] in {"installer_unlocked_file", "installer_stale_lock_entry"} for item in report["diagnostics"]))

    def test_lock_command_rejects_force(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                ["node", str(INSTALLER), "lock", "--project", directory, "--force"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
                env=self.command_env(),
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("--force is only supported by install/update", result.stderr)

    def test_rejects_symlinked_agent_target_before_writing(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside_directory:
            target = Path(directory)
            outside = Path(outside_directory) / "outside.toml"
            outside.write_text("outside\n", encoding="utf-8")
            profile = target / ".codex" / "agents" / "code_researcher.toml"
            profile.parent.mkdir(parents=True)
            profile.symlink_to(outside)

            result = self.run_installer(target, "--force")

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(outside.read_text(encoding="utf-8"), "outside\n")

    def test_rejects_agent_parent_that_resolves_outside_project(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside_directory:
            target = Path(directory)
            (target / ".codex").symlink_to(Path(outside_directory), target_is_directory=True)

            result = self.run_installer(target)

            self.assertNotEqual(result.returncode, 0)

    def test_rejects_symlinked_skill_root_before_running_skill_installer(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside_directory:
            target = Path(directory)
            (target / ".agents").mkdir()
            (target / ".agents" / "skills").symlink_to(Path(outside_directory), target_is_directory=True)

            result = subprocess.run(
                ["node", str(INSTALLER), "install", "--project", str(target), "--skills-only"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
                env=self.command_env(),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(Path(outside_directory).iterdir()), [])

    def test_rejects_skill_parent_that_resolves_outside_project(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as outside_directory:
            target = Path(directory)
            (target / ".agents").symlink_to(Path(outside_directory), target_is_directory=True)

            result = subprocess.run(
                ["node", str(INSTALLER), "install", "--project", str(target), "--skills-only"],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
                env=self.command_env(),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(Path(outside_directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
