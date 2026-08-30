#!/usr/bin/env node

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: harness-codex install [options]

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
  if (command !== "install") {
    throw new Error("expected `install` command");
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
      options.installSkills = false;
    } else if (arg === "--skills-only") {
      options.installAgents = false;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (!options.installAgents && !options.installSkills) {
    throw new Error("--agents-only and --skills-only cannot be combined");
  }
  return options;
}

async function assertDirectory(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`project directory not found: ${path}`);
}

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
  await mkdir(targetDir, { recursive: true });

  const entries = (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".toml"))
    .sort((left, right) => left.name.localeCompare(right.name));
  const installed = [];
  const skipped = [];

  for (const entry of entries) {
    const source = join(sourceDir, entry.name);
    const target = join(targetDir, entry.name);
    const exists = await stat(target).then(() => true, () => false);
    if (exists && !force) {
      skipped.push(entry.name);
      continue;
    }

    const content = await readFile(source, "utf8");
    const projectLocalContent = content.replaceAll(
      ".codex/skills/",
      ".agents/skills/",
    );
    await writeFile(target, projectLocalContent, "utf8");
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
  if (options.installSkills) installSkills(projectRoot);
  const agentResult = options.installAgents
    ? await installAgents(projectRoot, options.force)
    : { installed: [], skipped: [] };
  await verify(projectRoot, options);

  console.log(`Project-local Harness installation complete: ${projectRoot}`);
  if (agentResult.installed.length > 0) {
    console.log(`Installed agents: ${agentResult.installed.join(", ")}`);
  }
  if (agentResult.skipped.length > 0) {
    console.log(`Skipped existing agents: ${agentResult.skipped.join(", ")}`);
  }
}

main().catch((error) => {
  console.error(`Installation failed: ${error.message}`);
  process.exitCode = 1;
});
