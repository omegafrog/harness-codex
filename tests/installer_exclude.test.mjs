import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { protectLocalInstallArtifacts } from "../src/installer/local-exclude.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

async function createGitRepository(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const result = spawnSync("git", ["init", "--quiet", root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return root;
}

async function readExclude(root) {
  return readFile(join(root, ".git", "info", "exclude"), "utf8");
}

test("source checkout installation keeps tracked .codex assets out of local exclude", async () => {
  const sourceRoot = await createGitRepository("harness-source-");
  await writeFile(join(sourceRoot, ".git", "info", "exclude"), ".codex/\n", "utf8");

  await protectLocalInstallArtifacts(sourceRoot, sourceRoot);

  const exclude = await readExclude(sourceRoot);
  assert.doesNotMatch(exclude, /^\.codex\/$/m);
  assert.match(exclude, /^\.agents\/$/m);
  assert.match(exclude, /^skills-lock\.json$/m);
});

test("consumer installation excludes its local .codex runtime", async () => {
  const sourceRoot = await createGitRepository("harness-source-");
  const consumerRoot = await createGitRepository("harness-consumer-");

  await protectLocalInstallArtifacts(consumerRoot, sourceRoot);

  assert.match(await readExclude(consumerRoot), /^\.codex\/$/m);
});

test("skill-only installation invokes npx without an undefined spawnSync", async () => {
  const targetRoot = await createGitRepository("harness-consumer-");
  const executableRoot = await mkdtemp(join(tmpdir(), "harness-npx-"));
  const npxPath = join(executableRoot, "npx");
  const requiredSkills = ["architecture-review", "code-review", "e2e-test", "frontend-design", "frontend-figma", "frontend-implement", "frontend-visual-review", "harness-maintenance"];
  const script = `#!/usr/bin/env node\nconst { mkdirSync, writeFileSync } = require("node:fs");\nconst { join } = require("node:path");\nfor (const skill of ${JSON.stringify(requiredSkills)}) { const path = join(process.cwd(), ".agents", "skills", skill); mkdirSync(path, { recursive: true }); writeFileSync(join(path, "SKILL.md"), "# mock\\n"); }\n`;
  await writeFile(npxPath, script, "utf8");
  await chmod(npxPath, 0o755);

  const result = spawnSync(process.execPath, [join(repositoryRoot, "bin", "harness-install.mjs"), "install", "--skills-only", "--project", targetRoot], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${executableRoot}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /spawnSync is not defined/);
});
