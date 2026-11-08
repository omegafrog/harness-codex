#!/usr/bin/env node

import { lstat, realpath, readdir, readFile, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { updateProject, writeHarnessLock } from "../.harness/src/installer/index.mjs";
import { protectLocalInstallArtifacts } from "../.harness/src/installer/local-exclude.mjs";
import { isHarnessSourceCheckout } from "../.harness/src/installer/source-checkout.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: harness-codex <install|update|lock> [options]\n\nOptions:\n  --project <path>  Installation target (default: current directory)\n  --agents-only     Install only .codex/agents profiles\n  --skills-only     Install only Codex skills\n  --force           Back up and overwrite selected managed files (install; update always does)\n  --no-backup       Update managed files without saving local copies (update only)\n  -h, --help        Show this help\n`;
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
    noBackup: false,
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
    } else if (arg === "--no-backup") {
      if (command !== "update") throw new Error("--no-backup is only supported by update");
      options.noBackup = true;
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
    for (const name of ["orchestrator", "eli5", "setup"]) {
      await stat(join(projectRoot, ".agents", "skills", name, "SKILL.md"));
      await stat(join(projectRoot, ".claude", "skills", name, "SKILL.md"));
    }
    const internalSkills = new Set(await readdir(join(projectRoot, ".codex", "internal-skills")));
    const lock = JSON.parse(await readFile(join(projectRoot, ".codex", "harness-lock.json"), "utf8"));
    for (const directory of [".agents/skills", ".claude/skills"]) {
      const exposed = await readdir(join(projectRoot, directory));
      const unexpected = exposed.find((name) => internalSkills.has(name) && !["orchestrator", "eli5", "setup"].includes(name)
        && lock.files?.[`${directory}/${name}/SKILL.md`]
        && [`.codex/internal-skills/${name}/GUIDE.md`, `.codex/skills/${name}/SKILL.md`].includes(lock.files[`${directory}/${name}/SKILL.md`].source_path));
      if (unexpected) throw new Error(`Internal Harness skill is publicly exposed: ${directory}/${unexpected}`);
    }
    await stat(join(projectRoot, ".codex", "internal-skills", "product-spec", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "architecture-spec", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "code-review", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "frontend-figma", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "frontend-implement", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "frontend-visual-review", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "harness-maintenance", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "architecture-review", "GUIDE.md"));
    await stat(join(projectRoot, ".codex", "internal-skills", "beads", "GUIDE.md"));
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
    ".harness/src/workflow/stage-gates.mjs",
    ".harness/src/workflow/startup-state.mjs",
    ".harness/src/workflow/execution-state.mjs",
    ".harness/src/workflow/stage-input.mjs",
    ".harness/src/workflow/spec-review.mjs",
    ".harness/src/workflow/review-attempts.mjs",
    ".harness/src/wrapper/repair.mjs",
    ".harness/src/knowledge/evidence.mjs",
    ".codex/scripts/harness-plan-review.mjs",
    ".codex/scripts/harness-code-review.mjs",
    ".codex/scripts/harness-review-status.mjs",
    ".harness/src/workflow/plan-review.mjs",
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
    if (syncResult.removed_directories?.length) console.log(`Removed empty directories: ${syncResult.removed_directories.join(", ")}`);
    console.log("Updated .codex/harness-lock.json");
    if (fullInstall) console.log("Setup available: invoke $setup for Codex native choices; the skill uses harness-setup.mjs --answers to validate and apply submitted selections. Observability uses the same setup path.");
    const beadsVersion = ensureBeadsCli();
    console.log(beadsVersion
      ? `Beads CLI available: ${beadsVersion}`
      : "Beads CLI installation failed. Install it manually with: npm install --global @beads/bd");
  } else if (options.command === "lock") {
    await writeHarnessLock({ sourceRoot: packageRoot, targetRoot: projectRoot });
    console.log(`Harness lock written: ${join(projectRoot, ".codex", "harness-lock.json")}`);
  } else {
    // update always matches the latest release for Harness-owned paths; local edits are backed up first.
    const result = await updateProject({ sourceRoot: packageRoot, targetRoot: projectRoot, force: true, noBackup: options.noBackup });
    await protectLocalInstallArtifacts(projectRoot, packageRoot);
    console.log(`Harness update complete: ${projectRoot}`);
    if (result.updated.length > 0) console.log(`Updated: ${result.updated.join(", ")}`);
    if (result.added.length > 0) console.log(`Added: ${result.added.join(", ")}`);
    if (result.backup_directory) console.log(`Local backups: ${result.backup_directory}`);
    if (result.retired?.length) console.log(`Retired managed assets: ${result.retired.join(", ")}`);
    if (result.removed_lock_entries.length) console.log(`Retired lock entries: ${result.removed_lock_entries.join(", ")}`);
    if (result.removed_directories?.length) console.log(`Removed empty directories: ${result.removed_directories.join(", ")}`);
    if (result.skipped.length > 0) console.log(`Preserved: ${result.skipped.map((entry) => `${entry.path} (${entry.status})`).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(`Installation failed: ${error.message}`);
  process.exitCode = 1;
});
