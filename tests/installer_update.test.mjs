import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { buildHarnessLock, updateProject, writeHarnessLock } from "../src/installer/update.mjs";

async function makeSourceAndTarget() {
  const sourceRoot = await mkdtemp(join(tmpdir(), "harness-installer-source-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "harness-installer-target-"));
  await Promise.all([
    mkdir(join(sourceRoot, ".codex", "agents"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "workflows"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "schemas"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "skills", "alpha"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "agents"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "workflows"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "schemas"), { recursive: true }),
    mkdir(join(targetRoot, ".agents", "skills", "alpha"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(sourceRoot, ".codex", "harness.yaml"), "tracker:\n  mode: github\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.codex/skills/alpha/SKILL.md'\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "workflows", "review.yaml"), "schema_version: 1\nid: review\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "schemas", "case.yaml"), "schema_version: 1\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "harness.yaml"), "tracker:\n  mode: github\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.agents/skills/alpha/SKILL.md'\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "workflows", "review.yaml"), "schema_version: 1\nid: review\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "schemas", "case.yaml"), "schema_version: 1\n", "utf8"),
    writeFile(join(targetRoot, ".agents", "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8"),
  ]);
  return { sourceRoot, targetRoot };
}

test("lock generation records transformed agent sources and harness config", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();

  const lock = await buildHarnessLock({ sourceRoot, targetRoot });

  assert.ok(lock.files[".codex/harness.yaml"]);
  assert.equal(lock.files[".codex/agents/runner.toml"].source_transform, "project-local-paths-v1");
  assert.equal(Object.keys(lock.files).length, 5);
});

test("lock generation can leave skipped user-owned files unlocked", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();

  const lock = await buildHarnessLock({ sourceRoot, targetRoot, excludePaths: [".codex/agents/runner.toml"] });

  assert.equal(lock.files[".codex/agents/runner.toml"], undefined);
  assert.ok(lock.files[".codex/harness.yaml"]);
});

test("update replaces safe upstream changes, adds new skills, and preserves local edits", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.codex/skills/alpha/SKILL.md'\nversion = 2\n", "utf8");
  await mkdir(join(sourceRoot, ".codex", "skills", "beta"), { recursive: true });
  await writeFile(join(sourceRoot, ".codex", "skills", "beta", "SKILL.md"), "# beta\n", "utf8");
  await writeFile(join(targetRoot, ".codex", "workflows", "review.yaml"), "local workflow\n", "utf8");

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.updated, [".codex/agents/runner.toml"]);
  assert.deepEqual(result.added, [".agents/skills/beta/SKILL.md"]);
  assert.ok(result.skipped.some((entry) => entry.path === ".codex/workflows/review.yaml" && entry.status === "locally_modified"));
  assert.match(await readFile(join(targetRoot, ".codex", "agents", "runner.toml"), "utf8"), /version = 2/);
  assert.equal(await readFile(join(targetRoot, ".agents", "skills", "beta", "SKILL.md"), "utf8"), "# beta\n");
  assert.equal((await readFile(join(targetRoot, ".codex", "harness-lock.json"), "utf8")).includes("beta/SKILL.md"), true);
});

test("update preserves a conflict and restores a missing locked file", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.codex/skills/alpha/SKILL.md'\nsource = 2\n", "utf8");
  await writeFile(join(targetRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.agents/skills/alpha/SKILL.md'\nlocal = true\n", "utf8");
  await unlink(join(targetRoot, ".codex", "schemas", "case.yaml"));

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.ok(result.skipped.some((entry) => entry.path === ".codex/agents/runner.toml" && entry.status === "conflict"));
  assert.match(await readFile(join(targetRoot, ".codex", "agents", "runner.toml"), "utf8"), /local = true/);
  assert.ok(result.updated.includes(".codex/schemas/case.yaml"));
  assert.equal(await readFile(join(targetRoot, ".codex", "schemas", "case.yaml"), "utf8"), "schema_version: 1\n");
});

test("update adds new workflow and nested schema files to the owned inventory", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, ".codex", "workflows", "new.yaml"), "schema_version: 1\nid: new\n", "utf8");
  await mkdir(join(sourceRoot, ".codex", "schemas", "tracker"), { recursive: true });
  await writeFile(join(sourceRoot, ".codex", "schemas", "tracker", "plan.yaml"), "schema_version: 1\n", "utf8");

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.added, [".codex/schemas/tracker/plan.yaml", ".codex/workflows/new.yaml"]);
  assert.equal(await readFile(join(targetRoot, ".codex", "schemas", "tracker", "plan.yaml"), "utf8"), "schema_version: 1\n");
  assert.equal(await readFile(join(targetRoot, ".codex", "workflows", "new.yaml"), "utf8"), "schema_version: 1\nid: new\n");
});
