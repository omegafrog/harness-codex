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
  await writeFile(join(sourceRoot, ".git", "info", "exclude"), ".codex/\n.codex/agents/\n.harness/\n.github/workflows/harness-contracts.yml\n", "utf8");

  await protectLocalInstallArtifacts(sourceRoot, sourceRoot);

  const exclude = await readExclude(sourceRoot);
  assert.doesNotMatch(exclude, /^\.codex\/$/m);
  assert.doesNotMatch(exclude, /^\.codex\/agents\/$/m);
  assert.doesNotMatch(exclude, /^\.harness\/$/m);
  assert.doesNotMatch(exclude, /^\.github\/workflows\/harness-contracts\.yml$/m);
  assert.match(exclude, /^\.agents\/$/m);
  assert.match(exclude, /^skills-lock\.json$/m);
});

test("consumer installation excludes its local .codex runtime", async () => {
  const sourceRoot = await createGitRepository("harness-source-");
  const consumerRoot = await createGitRepository("harness-consumer-");

  await protectLocalInstallArtifacts(consumerRoot, sourceRoot);

  let exclude = await readExclude(consumerRoot);
  assert.match(exclude, /^\.codex\/$/m);
  assert.match(exclude, /^\.harness\/$/m);
  assert.match(exclude, /^\.github\/workflows\/harness-contracts\.yml$/m);
  assert.match(exclude, /^\.agents\/$/m);
  assert.match(exclude, /^skills-lock\.json$/m);
  await protectLocalInstallArtifacts(consumerRoot, sourceRoot);
  exclude = await readExclude(consumerRoot);
  assert.equal((exclude.match(/^\.harness\/$/gm) || []).length, 1);
  assert.equal((exclude.match(/^\.github\/workflows\/harness-contracts\.yml$/gm) || []).length, 1);
});

test("skill-only installation copies bundled skills without invoking npx", async () => {
  const targetRoot = await createGitRepository("harness-consumer-");
  const executableRoot = await mkdtemp(join(tmpdir(), "harness-npx-"));
  const npxPath = join(executableRoot, "npx");
  const invoked = join(executableRoot, "invoked");
  const script = `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(invoked)}, "yes");\n`;
  await writeFile(npxPath, script, "utf8");
  await chmod(npxPath, 0o755);

  const result = spawnSync(process.execPath, [join(repositoryRoot, "bin", "harness-install.mjs"), "install", "--skills-only", "--project", targetRoot], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${executableRoot}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(targetRoot, ".agents/skills/spec-me/SKILL.md"), "utf8"), await readFile(join(repositoryRoot, ".codex/skills/spec-me/SKILL.md"), "utf8"));
  await assert.rejects(readFile(invoked), { code: "ENOENT" });
});

test("installing into an uninitialized child directory never changes the parent Git exclude", async () => {
  const parent = await createGitRepository("harness-parent-");
  const source = await createGitRepository("harness-source-");
  const target = join(parent, "nested-project");
  await mkdir(target);
  const before = await readExclude(parent);
  await protectLocalInstallArtifacts(target, source);
  assert.equal(await readExclude(parent), before);
});
