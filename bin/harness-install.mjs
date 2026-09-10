#!/usr/bin/env node

import { lstat, mkdir, readFile, readdir, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { updateProject, writeHarnessLock } from "../src/installer/index.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: harness-codex <install|update|lock> [options]

Options:
  --project <path>  Installation target (default: current directory)
  --agents-only     Install only .codex/agents profiles
  --skills-only     Install only Codex skills
  --force           Overwrite existing agent profiles
  -h, --help        Show this help
`;
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

const pathSeparator = process.platform === "win32" ? "\\" : "/";

function installSkills(projectRoot) {
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
  }
  if (options.installAgents) {
    for (const name of [
      "code_researcher.toml",
      "spec_reviewer.toml",
      "standards_reviewer.toml",
    ]) {
      await stat(join(projectRoot, ".codex", "agents", name));
    }
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
  if (options.command === "install") {
    if (options.installSkills) installSkills(projectRoot);
    const agentResult = options.installAgents
      ? await installAgents(projectRoot, options.force)
      : { installed: [], skipped: [] };
    await verify(projectRoot, options);
    await writeHarnessLock({
      sourceRoot: packageRoot,
      targetRoot: projectRoot,
      excludePaths: agentResult.skipped.map((name) => `.codex/agents/${name}`),
    });

    console.log(`Project-local Harness installation complete: ${projectRoot}`);
    if (agentResult.installed.length > 0) {
      console.log(`Installed agents: ${agentResult.installed.join(", ")}`);
    }
    if (agentResult.skipped.length > 0) {
      console.log(`Skipped existing agents: ${agentResult.skipped.join(", ")}`);
    }
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
