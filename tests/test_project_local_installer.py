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
    def command_env(self, call_log: Path | None = None) -> dict[str, str]:
        env = {**os.environ, "PATH": f"{INSTALLER_STUBS}{os.pathsep}{os.environ['PATH']}"}
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

    def run_full_installer(self, target: Path, call_log: Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["node", str(INSTALLER), "install", "--project", str(target)],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
            env=self.command_env(call_log),
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
            self.assertIn("Project-local Harness installation complete", result.stdout)
            agents = target / ".codex" / "agents"
            self.assertEqual(
                {path.name for path in agents.glob("*.toml")},
                {
                    "code_researcher.toml",
                    "architecture_review_lead.toml",
                    "diagram_creator.toml",
                    "spec_reviewer.toml",
                    "plan_reviewer.toml",
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
                self.assertTrue(
                    ".agents/skills/" in data["developer_instructions"]
                    or ".codex/internal-skills/" in data["developer_instructions"]
                )
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
            self.assertTrue((target / ".codex" / "internal-skills" / "architecture-review" / "GUIDE.md").is_file())
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

    @unittest.skipUnless(os.name == "posix", "Interactive CLI requires a POSIX PTY")
    def test_installed_setup_reaches_model_prompt_without_writing_configuration(self):
        import pty
        import select
        import time
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)
            self.configure_target(target)
            self.assertEqual(self.run_full_installer(target).returncode, 0)
            config = target / ".codex/harness.yaml"
            previous = config.read_bytes()
            master, slave = pty.openpty()
            process = subprocess.Popen(["node", str(target / ".codex/scripts/harness-setup.mjs"), "--root", str(target)], cwd=target, env=self.command_env(), stdin=slave, stdout=slave, stderr=slave)
            os.close(slave)
            output = b""
            try:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and "모델 선택".encode() not in output:
                    if select.select([master], [], [], 0.1)[0]:
                        try:
                            output += os.read(master, 8192)
                        except OSError:
                            break
                    if process.poll() is not None:
                        break
                self.assertIn("모델 선택".encode(), output, output.decode(errors="replace"))
                self.assertIn("권장:".encode(), output)
                self.assertNotIn(b"is not defined", output)
            finally:
                process.terminate()
                process.wait(timeout=5)
                os.close(master)
            self.assertEqual(config.read_bytes(), previous)

    def test_full_install_prepares_victorialogs_without_provider_plugin(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)
            call_log = target / "codex.log"
            result = self.run_full_installer(target, call_log=call_log)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("SigNoz", call_log.read_text(encoding="utf-8"))
            helper = target / ".codex/scripts/harness-victorialogs.mjs"
            projects = [{"id": "app-a", "root": str(target), "services": [{"name": "api", "metrics_url": "http://127.0.0.1:18081/custom/prometheus", "scrape_url": "http://host.docker.internal:18081/custom/prometheus"}, {"name": "worker", "metrics_url": "http://127.0.0.1:18082/actuator/prometheus", "scrape_url": "http://host.docker.internal:18082/actuator/prometheus"}]}]
            setup = ["node", str(helper), "setup", "--root", str(target), "--port", "19428", "--retention-days", "3", "--metrics-port", "18428", "--otel-port", "14318", "--projects", json.dumps(projects)]
            prepared = subprocess.run(setup, cwd=target, text=True, capture_output=True)
            self.assertEqual(prepared.returncode, 0, prepared.stderr)
            config_dir = target / "docs/observability/victorialogs"
            self.assertEqual(json.loads((config_dir / "config.json").read_text()), {"port": 19428, "retention_days": 3, "metrics_port": 18428, "metrics_retention_days": 7, "otel_port": 14318, "projects": projects})
            compose = (config_dir / "compose.yaml").read_text()
            self.assertIn("otel/opentelemetry-collector-contrib:", compose)
            self.assertIn("victoriametrics:", compose)
            self.assertNotIn("vector", compose)
            self.assertNotIn("fluent-bit", compose)
            self.assertNotIn("network_mode: host", compose)
            self.assertIn("127.0.0.1:${HARNESS_OTEL_PORT:?}:4318", compose)
            collector = (config_dir / "otel-collector.yaml").read_text()
            self.assertIn("/insert/opentelemetry/v1/logs", collector)
            self.assertIn("encoding: proto", collector)
            self.assertIn("http://victorialogs:9428/insert/opentelemetry/v1/logs", collector)
            self.assertIn("endpoint: 0.0.0.0:4318", collector)
            self.assertIn("http://127.0.0.1:14318/v1/logs", (config_dir / "otel-javaagent.properties").read_text())
            jobs = json.loads((config_dir / "scrape.json").read_text())["scrape_configs"]
            self.assertEqual(jobs[0]["metrics_path"], "/custom/prometheus")
            self.assertEqual(jobs[0]["static_configs"], [{"targets": ["host.docker.internal:18081"], "labels": {"project": "app-a", "service": "api"}}])
            self.assertEqual(jobs[1]["job_name"], "app-a/worker")
            self.assertEqual(json.loads((config_dir / "mcp.json").read_text())["mcpServers"]["victoriametrics"]["args"][1], "mcp-metrics")
            mcp = json.loads((config_dir / "mcp.json").read_text())["mcpServers"]["victorialogs"]
            self.assertEqual(mcp["args"][-2:], ["--root", str(target)])
            docker_bin = target / "probe-bin"
            docker_bin.mkdir()
            docker = docker_bin / "docker"
            docker.write_text('#!/usr/bin/env python3\nimport json,sys\nprint(json.dumps(sys.argv[1:]))\n')
            docker.chmod(0o755)
            for command, endpoint in [("mcp", "VL_INSTANCE_ENTRYPOINT=http://victorialogs:9428"), ("mcp-metrics", "VM_INSTANCE_ENTRYPOINT=http://victoriametrics:8428")]:
                invoked = subprocess.run(["node", str(helper), command, "--root", str(target)], cwd=target, env={**os.environ, "PATH": str(docker_bin) + os.pathsep + os.environ["PATH"]}, text=True, capture_output=True)
                self.assertEqual(invoked.returncode, 0, invoked.stderr)
                argv = json.loads(invoked.stdout)
                self.assertTrue(argv[argv.index("--network") + 1].endswith("_default"))
                self.assertIn(endpoint, argv)
            profiles = json.loads((target / "docs/agents/execution.json").read_text())["profiles"]
            self.assertIn("victorialogs-infrastructure", profiles)
            self.assertIn("victorialogs-check", profiles)
            self.assertIn("victorialogs-diagnostic-logs", profiles)
            self.assertTrue((config_dir / "diagnostic-log.schema.json").exists())
            self.assertIn("spring-boot-diagnostic-log-v1", (target / "docs/agents/implementation-guidance.md").read_text())
            self.assertIn("spring-boot-diagnostic-log-v1", (target / "docs/agents/testing-guidance.md").read_text())
            validated = subprocess.run(["node", str(target / ".codex/scripts/harness-exec.mjs"), "--root", str(target), "--profile", "victorialogs-diagnostic-logs"], cwd=target, env={**os.environ, "HARNESS_DIAGNOSTIC_LOG_FILE": str(config_dir / "diagnostic-log.example.json")}, text=True, capture_output=True)
            self.assertEqual(validated.returncode, 0, validated.stderr + validated.stdout)
            validation = subprocess.run(["node", "--input-type=module", "-e", "const {readExecutionManifest}=await import(process.argv[1]);await readExecutionManifest(process.argv[2]);", (target / ".codex/harness-runtime/src/workflow/execution.mjs").as_uri(), str(target)], cwd=target, text=True, capture_output=True)
            self.assertEqual(validation.returncode, 0, validation.stderr)
            original = (config_dir / "compose.yaml").read_text() + "\n# project customization\n"
            (config_dir / "compose.yaml").write_text(original)
            custom_mcp = json.loads((config_dir / "mcp.json").read_text())
            custom_mcp["mcpServers"]["custom"] = {"command": "custom-client"}
            (config_dir / "mcp.json").write_text(json.dumps(custom_mcp))
            repeated = subprocess.run(setup, cwd=target, text=True, capture_output=True)
            self.assertEqual(repeated.returncode, 0, repeated.stderr)
            self.assertEqual((config_dir / "compose.yaml").read_text(), original)
            self.assertEqual(json.loads((config_dir / "mcp.json").read_text())["mcpServers"]["custom"], {"command": "custom-client"})
            self.assertEqual((target / "docs/agents/testing-guidance.md").read_text().count("### opentelemetry-local-observability-v2"), 1)
            # Legacy migration replaces the active collector and backs up its customization.
            (config_dir / "compose.yaml").write_text("services:\n  fluent-bit:\n    image: legacy\n# project customization\n")
            migrated = subprocess.run(setup, cwd=target, text=True, capture_output=True)
            self.assertEqual(migrated.returncode, 0, migrated.stderr)
            self.assertNotIn("fluent-bit:", (config_dir / "compose.yaml").read_text())
            self.assertTrue(any("image: legacy" in path.read_text() for path in (target / ".git/harness-workflows/sessions").glob("*/runtime/setup/backups/compose.yaml-*")))
            self.assertEqual((target / "docs/agents/testing-guidance.md").read_text().count("### spring-boot-diagnostic-log-v1"), 1)
            invalid = subprocess.run(["node", str(helper), "setup", "--root", str(target), "--metrics-port", "70000"], cwd=target, text=True, capture_output=True)
            self.assertNotEqual(invalid.returncode, 0)
            same_port = subprocess.run(["node", str(helper), "setup", "--root", str(target), "--metrics-port", "19428"], cwd=target, text=True, capture_output=True)
            self.assertNotEqual(same_port.returncode, 0)
            projects[0]["services"][0]["metrics_url"] = "http://secret:password@127.0.0.1:18081/metrics"
            invalid_url = subprocess.run(["node", str(helper), "setup", "--root", str(target), "--projects", json.dumps(projects)], cwd=target, text=True, capture_output=True)
            self.assertNotEqual(invalid_url.returncode, 0)

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

    def test_update_replaces_managed_skill_and_preserves_backups(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            subprocess.run(["git", "init", "-q", str(target)], check=True)
            self.configure_target(target)
            install = self.run_full_installer(target)
            self.assertEqual(install.returncode, 0, install.stderr)
            skill = target / ".agents" / "skills" / "spec-me" / "SKILL.md"
            upstream = (ROOT / ".codex" / "skills" / "spec-me" / "SKILL.md").read_text(encoding="utf-8")
            skill.write_text("local skill\n", encoding="utf-8")

            updated = self.run_update(target)
            self.assertEqual(updated.returncode, 0, updated.stderr)
            self.assertEqual(skill.read_text(encoding="utf-8"), upstream)
            default_backup_line = next(line for line in updated.stdout.splitlines() if line.startswith("Local backups: "))
            default_backup = Path(default_backup_line.removeprefix("Local backups: ")) / ".agents/skills/spec-me/SKILL.md"
            self.assertEqual(default_backup.read_text(encoding="utf-8"), "local skill\n")
            skill.write_text("local skill\n", encoding="utf-8")

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
