#!/usr/bin/env node

import { lstat, realpath, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { updateProject, writeHarnessLock } from "../src/installer/index.mjs";
import { protectLocalInstallArtifacts } from "../src/installer/local-exclude.mjs";
import { isHarnessSourceCheckout } from "../src/installer/source-checkout.mjs";
import { inspectProjectReadiness } from "../src/workflow/project-readiness.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: harness-codex <install|update|lock> [options]\n\nOptions:\n  --project <path>  Installation target (default: current directory)\n  --agents-only     Install only .codex/agents profiles\n  --skills-only     Install only Codex skills\n  --force           Back up and overwrite selected managed files (install/update)\n  -h, --help        Show this help\n`;
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (command === "--help" || command === "-h") {
    return { help: true };
  }
  if (!["install", "update", "lock"].includes(command)) {
    throw new Error("expected `install`, `update`, or `lock` command");
  }

  const options = {
    project: process.cwd(),
    installAgents: true,
    installSkills: true,
    force: false,
  };

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--project") {
      const value = args.shift();
      if (!value) throw new Error("--project requires a path");
      options.project = value;
    } else if (arg === "--agents-only") {
      if (command !== "install") throw new Error("--agents-only is only supported by install");
      options.installSkills = false;
    } else if (arg === "--skills-only") {
      if (command !== "install") throw new Error("--skills-only is only supported by install");
      options.installAgents = false;
    } else if (arg === "--force") {
      if (command === "lock") throw new Error("--force is only supported by install/update");
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (command === "install" && !options.installAgents && !options.installSkills) {
    throw new Error("--agents-only and --skills-only cannot be combined");
  }
  return { ...options, command };
}

async function assertDirectory(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`project directory not found: ${path}`);
}

async function assertContainedParent(projectRoot, path) {
  const rootPath = await realpath(projectRoot);
  let candidate = dirname(path);
  while (true) {
    try {
      const actual = await realpath(candidate);
      if (!actual.startsWith(`${rootPath}${pathSeparator}`) && actual !== rootPath) throw new Error(`installer path escapes project: ${path}`);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error(`installer parent does not exist: ${path}`);
      candidate = parent;
    }
  }
}

async function assertSafeDirectory(projectRoot, path, label) {
  await assertContainedParent(projectRoot, path);
  const information = await lstat(path).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!information) return;
  if (information.isSymbolicLink() || !information.isDirectory()) throw new Error(`${label} must be a real directory: ${path}`);
  const rootPath = await realpath(projectRoot);
  const actualPath = await realpath(path);
  if (!actualPath.startsWith(`${rootPath}${pathSeparator}`) && actualPath !== rootPath) throw new Error(`${label} escapes project: ${path}`);
}

const pathSeparator = process.platform === "win32" ? "\\" : "/";

function runCodex(args) {
  const executable = process.platform === "win32" ? "codex.cmd" : "codex";
  const result = spawnSync(executable, args, { encoding: "utf8" });
  if (result.error) throw new Error(`Unable to run Codex plugin command: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Codex plugin command failed (${args.join(" ")}): ${result.stderr || result.stdout}`);
  return result.stdout;
}

function installPonytailPlugin() {
  const marketplaceUrl = "https://github.com/DietrichGebert/ponytail.git";
  const marketplaceResult = JSON.parse(runCodex(["plugin", "marketplace", "list", "--json"]));
  const existing = marketplaceResult.marketplaces?.find((marketplace) => marketplace.name === "ponytail");
  if (existing && existing.marketplaceSource?.source !== marketplaceUrl) {
    throw new Error(`Codex marketplace 'ponytail' already points to a different source: ${existing.marketplaceSource?.source || existing.root}`);
  }
  if (!existing) runCodex(["plugin", "marketplace", "add", "DietrichGebert/ponytail"]);

  const pluginResult = JSON.parse(runCodex(["plugin", "list", "--json"]));
  const installed = pluginResult.installed?.some((plugin) => plugin.pluginId === "ponytail@ponytail" && plugin.enabled === true);
  if (!installed) runCodex(["plugin", "add", "ponytail@ponytail"]);
}

function beadsCliVersion() {
  const executables = process.platform === "win32" ? [["bd.exe", false], ["bd.cmd", true]] : [["bd", false]];
  for (const [executable, shell] of executables) {
    const result = spawnSync(executable, ["version"], { encoding: "utf8", shell });
    if (result.status === 0) return (result.stdout || result.stderr).trim() || "available";
  }
  return null;
}

function ensureBeadsCli() {
  const existingVersion = beadsCliVersion();
  if (existingVersion) return existingVersion;

  const windows = process.platform === "win32";
  const npm = windows ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["install", "--global", "@beads/bd"], { stdio: "inherit", shell: windows });
  return result.status === 0 ? beadsCliVersion() : null;
}

async function verify(projectRoot, options) {
  if (options.installSkills) {
    await stat(join(projectRoot, ".agents", "skills", "spec-me", "SKILL.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "product-spec", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "architecture-spec", "GUIDE.md"));
    await stat(join(projectRoot, ".agents", "skills", "code-review", "SKILL.md"));
    await stat(join(projectRoot, ".agents", "skills", "e2e-test", "SKILL.md"));
    await stat(join(projectRoot, ".agents", "skills", "frontend-design", "SKILL.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "frontend-figma", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "frontend-implement", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "frontend-visual-review", "GUIDE.md"));
    await stat(join(projectRoot, ".agents", "skills", "harness-maintenance", "SKILL.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "architecture-review", "GUIDE.md"));
    await stat(join(projectRoot, ".agents", "skills", "beads", "SKILL.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "plan-review", "GUIDE.md"));
  }
  if (options.installAgents) {
    for (const name of [
      "code_researcher.toml",
      "architecture_review_lead.toml",
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
      "plan_reviewer.toml",
    ]) {
      await stat(join(projectRoot, ".codex", "agents", name));
    }
  }
}

async function verifyManagedRuntime(projectRoot) {
  for (const path of [
    ".github/pull_request_template.md",
    ".codex/workflows/spec-me.yaml",
    ".codex/scripts/harness-workspace-preflight.mjs",
    ".codex/workflows/code-review.yaml",
    ".codex/workflows/frontend-design.yaml",
    ".codex/harness-runtime/src/workflow/stage-gates.mjs",
    ".codex/harness-runtime/src/knowledge/evidence.mjs",
    ".codex/scripts/harness-plan-traceability.mjs",
    ".codex/harness-runtime/src/workflow/plan-traceability.mjs",
  ]) {
    await stat(join(projectRoot, path));
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const projectRoot = resolve(options.project);
  await assertDirectory(projectRoot);
  if (options.command === "install" || options.command === "update") {
    await protectLocalInstallArtifacts(projectRoot, packageRoot);
  }
  if (await isHarnessSourceCheckout(packageRoot, projectRoot)) {
    console.log(`Harness source checkout uses repository-owned runtime: ${projectRoot}`);
    console.log(`Skipped ${options.command}; skills remain in .codex/skills and agent profiles in .codex/agents.`);
    return;
  }
  if (options.command === "install") {
    if (options.installSkills) await assertSafeDirectory(projectRoot, join(projectRoot, ".agents", "skills"), "skill target directory");
    if (options.installAgents) await assertSafeDirectory(projectRoot, join(projectRoot, ".codex", "agents"), "agent target directory");
    const fullInstall = options.installSkills && options.installAgents;
    const syncResult = await updateProject({ sourceRoot: packageRoot, targetRoot: projectRoot, initialize: true, force: options.force, scope: fullInstall ? "all" : options.installAgents ? "agents" : "skills" });
    await verify(projectRoot, options);
    if (fullInstall) await verifyManagedRuntime(projectRoot);
    installPonytailPlugin();

    console.log(`Project-local Harness installation complete: ${projectRoot}`);
    if (syncResult.added.length > 0) console.log(`Installed managed assets: ${syncResult.added.join(", ")}`);
    if (syncResult.updated.length > 0) console.log(`Updated managed assets: ${syncResult.updated.join(", ")}`);
    if (syncResult.skipped.length > 0) console.log(`Preserved: ${syncResult.skipped.map((entry) => `${entry.path} (${entry.status})`).join(", ")}`);
    if (syncResult.retired?.length) console.log(`Retired managed assets: ${syncResult.retired.join(", ")}`);
    if (syncResult.backup_directory) console.log(`Local backups: ${syncResult.backup_directory}`);
    if (syncResult.removed_lock_entries.length) console.log(`Retired lock entries: ${syncResult.removed_lock_entries.join(", ")}`);
    console.log("Updated .codex/harness-lock.json");
    if (fullInstall) console.log("VictoriaLogs setup available: run node .codex/scripts/harness-setup.mjs; official MCP and development log collection are configured through the same path.");
    const beadsVersion = ensureBeadsCli();
    console.log(beadsVersion
      ? `Beads CLI available: ${beadsVersion}`
      : "Beads CLI installation failed. Install it manually with: npm install --global @beads/bd");
  } else if (options.command === "lock") {
    await writeHarnessLock({ sourceRoot: packageRoot, targetRoot: projectRoot });
    console.log(`Harness lock written: ${join(projectRoot, ".codex", "harness-lock.json")}`);
  } else {
    const result = await updateProject({ sourceRoot: packageRoot, targetRoot: projectRoot, force: options.force });
    console.log(`Harness update complete: ${projectRoot}`);
    if (result.updated.length > 0) console.log(`Updated: ${result.updated.join(", ")}`);
    if (result.added.length > 0) console.log(`Added: ${result.added.join(", ")}`);
    if (result.backup_directory) console.log(`Local backups: ${result.backup_directory}`);
    if (result.removed_lock_entries.length) console.log(`Retired lock entries: ${result.removed_lock_entries.join(", ")}`);
    if (result.skipped.length > 0) console.log(`Preserved: ${result.skipped.map((entry) => `${entry.path} (${entry.status})`).join(", ")}`);
  }
  if (options.command !== 'lock') {
    const readiness = await inspectProjectReadiness({ workspace_root: projectRoot });
    console.log(`Project readiness: ${readiness.status} (${readiness.reason})`);
    for (const step of readiness.next_steps) console.log(`Required preparation: ${step}`);
    if (readiness.status !== 'pass') console.log('Runtime files are installed; the calling agent must complete preparation and rerun doctor before reporting workflow completion or starting implementation.');
  }
}

main().catch((error) => {
  console.error(`Installation failed: ${error.message}`);
  process.exitCode = 1;
});
