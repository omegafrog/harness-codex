import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { protectLocalInstallArtifacts } from "../src/installer/local-exclude.mjs";

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
