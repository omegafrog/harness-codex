#!/usr/bin/env node

import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { updateProject, writeHarnessLock } from "../src/installer/index.mjs";
import { protectLocalInstallArtifacts } from "../src/installer/local-exclude.mjs";
import { isHarnessSourceCheckout } from "../src/installer/source-checkout.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: harness-codex <install|update|lock> [options]\n\nOptions:\n  --project <path>  Installation target (default: current directory)\n  --agents-only     Install only .codex/agents profiles\n  --skills-only     Install only Codex skills\n  --force           Overwrite existing agent profiles\n  -h, --help        Show this help\n`;
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
      if (command !== "install") throw new Error("--force is only supported by install");
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

async function installSkills(projectRoot) {
  await assertSafeDirectory(projectRoot, join(projectRoot, ".agents", "skills"), "skill target directory");
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    executable,
    [
      "--yes",
      "skills",
      "add",
      packageRoot,
      "--agent",
      "codex",
      "--skill",
      "*",
      "--copy",
      "--yes",
    ],
    { cwd: projectRoot, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`skills installation failed with exit code ${result.status}`);
  }
}

async function installAgents(projectRoot, force) {
  const sourceDir = join(packageRoot, ".codex", "agents");
  const targetDir = join(projectRoot, ".codex", "agents");
  await assertContainedParent(projectRoot, targetDir);
  await mkdir(targetDir, { recursive: true });
  const targetDirInfo = await lstat(targetDir);
  if (targetDirInfo.isSymbolicLink() || !targetDirInfo.isDirectory()) throw new Error(`agent target directory must be a real directory: ${targetDir}`);

  const entries = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const installed = [];
  const skipped = [];

  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    const targetInfo = await lstat(target).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (targetInfo?.isSymbolicLink()) throw new Error(`agent target cannot be a symlink: ${target}`);
    if (targetInfo && !targetInfo.isFile()) throw new Error(`agent target must be a regular file: ${target}`);
    if (targetInfo && !force) {
      skipped.push(entry.name);
      continue;
    }

    const content = await readFile(source, "utf8");
    const projectLocalContent = content.replaceAll(
      ".codex/skills/",
      ".agents/skills/",
    );
    const temporary = `${target}.harness-install-${process.pid}-${Date.now()}`;
    await writeFile(temporary, projectLocalContent, { encoding: "utf8", flag: "wx" });
    try {
      await rename(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    installed.push(entry.name);
  }

  return { installed, skipped };
}

async function verify(projectRoot, options) {
  if (options.installSkills) {
    await stat(join(projectRoot, ".agents", "skills", "code-review", "SKILL.md"));
    await stat(join(projectRoot, ".agents", "skills", "e2e-test", "SKILL.md"));
    await stat(join(projectRoot, ".agents", "skills", "frontend-design", "SKILL.md"));
    await stat(join(projectRoot, ".agents", "skills", "frontend-figma", "SKILL.md"));
    await stat(join(projectRoot, ".agents", "skills", "frontend-implement", "SKILL.md"));
    await stat(join(projectRoot, ".agents", "skills", "frontend-visual-review", "SKILL.md"));
    await stat(join(projectRoot, ".agents", "skills", "harness-maintenance", "SKILL.md"));
  }
  if (options.installAgents) {
    for (const name of [
      "code_researcher.toml",
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
    ]) {
      await stat(join(projectRoot, ".codex", "agents", name));
    }
  }
}

async function verifyManagedRuntime(projectRoot) {
  for (const path of [
    ".codex/workflows/spec-me.yaml",
    ".codex/workflows/code-review.yaml",
    ".codex/workflows/frontend-design.yaml",
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
  if (await isHarnessSourceCheckout(packageRoot, projectRoot)) {
    console.log(`Harness source checkout uses repository-owned runtime: ${projectRoot}`);
    console.log(`Skipped ${options.command}; skills remain in .codex/skills and agent profiles in .codex/agents.`);
    return;
  }
  if (options.command === "install" || options.command === "update") {
    await protectLocalInstallArtifacts(projectRoot, packageRoot);
  }
  if (options.command === "install") {
    if (options.installSkills) await installSkills(projectRoot);
    const agentResult = options.installAgents
      ? await installAgents(projectRoot, options.force)
      : { installed: [], skipped: [] };
    await writeHarnessLock({
      sourceRoot: packageRoot,
      targetRoot: projectRoot,
      excludePaths: agentResult.skipped.map((name) => `.codex/agents/${name}`),
    });

    let syncResult = { added: [], updated: [], skipped: [] };
    const fullInstall = options.installSkills && options.installAgents;
    if (fullInstall) {
      // Initial install and update share the same managed-asset synchronization path.
      // This fills workflow/schema assets that are not owned by `npx skills` or agent copying,
      // while preserving project-specific .codex/harness.yaml for $setup.
      syncResult = await updateProject({ sourceRoot: packageRoot, targetRoot: projectRoot });
    }
    await verify(projectRoot, options);
    if (fullInstall) await verifyManagedRuntime(projectRoot);

    console.log(`Project-local Harness installation complete: ${projectRoot}`);
    if (agentResult.installed.length > 0) {
      console.log(`Installed agents: ${agentResult.installed.join(", ")}`);
    }
    if (agentResult.skipped.length > 0) {
      console.log(`Skipped existing agents: ${agentResult.skipped.join(", ")}`);
    }
    if (syncResult.added.length > 0) console.log(`Installed managed assets: ${syncResult.added.join(", ")}`);
    if (syncResult.updated.length > 0) console.log(`Updated managed assets: ${syncResult.updated.join(", ")}`);
    console.log("Updated .codex/harness-lock.json");
  } else if (options.command === "lock") {
    await writeHarnessLock({ sourceRoot: packageRoot, targetRoot: projectRoot });
    console.log(`Harness lock written: ${join(projectRoot, ".codex", "harness-lock.json")}`);
  } else {
    const result = await updateProject({ sourceRoot: packageRoot, targetRoot: projectRoot });
    console.log(`Harness update complete: ${projectRoot}`);
    if (result.updated.length > 0) console.log(`Updated: ${result.updated.join(", ")}`);
    if (result.added.length > 0) console.log(`Added: ${result.added.join(", ")}`);
    if (result.skipped.length > 0) console.log(`Preserved: ${result.skipped.map((entry) => `${entry.path} (${entry.status})`).join(", ")}`);
  }
}

main().catch((error) => {
  console.error(`Installation failed: ${error.message}`);
  process.exitCode = 1;
});
