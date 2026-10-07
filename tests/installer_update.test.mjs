import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildHarnessLock, updateProject, writeHarnessLock } from "../src/installer/update.mjs";
import { writeSystemTargets } from "../src/decision/artifacts.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function makeSourceAndTarget() {
  const sourceRoot = await mkdtemp(join(tmpdir(), "harness-installer-source-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "harness-installer-target-"));
  await Promise.all([
    mkdir(join(sourceRoot, ".codex", "agents"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "workflows"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "schemas"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "scripts"), { recursive: true }),
    mkdir(join(sourceRoot, ".codex", "skills", "alpha"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "agents"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "workflows"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "schemas"), { recursive: true }),
    mkdir(join(targetRoot, ".codex", "scripts"), { recursive: true }),
    mkdir(join(targetRoot, ".agents", "skills", "alpha"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(sourceRoot, ".codex", "harness.yaml"), "tracker:\n  mode: github\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.codex/skills/alpha/SKILL.md'\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "workflows", "review.yaml"), "schema_version: 1\nid: review\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "schemas", "case.yaml"), "schema_version: 1\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "scripts", "runner.mjs"), "console.log('runner');\n", "utf8"),
    writeFile(join(sourceRoot, ".codex", "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "harness.yaml"), "tracker:\n  mode: github\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "agents", "runner.toml"), "developer_instructions = '.agents/skills/alpha/SKILL.md'\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "workflows", "review.yaml"), "schema_version: 1\nid: review\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "schemas", "case.yaml"), "schema_version: 1\n", "utf8"),
    writeFile(join(targetRoot, ".codex", "scripts", "runner.mjs"), "console.log('runner');\n", "utf8"),
    writeFile(join(targetRoot, ".agents", "skills", "alpha", "SKILL.md"), "# alpha\n", "utf8"),
  ]);
  return { sourceRoot, targetRoot };
}

test("lock generation records managed assets but excludes project harness config", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();

  const lock = await buildHarnessLock({ sourceRoot, targetRoot });

  assert.equal(lock.files[".codex/harness.yaml"], undefined);
  assert.equal(lock.files[".codex/agents/runner.toml"].source_transform, "project-local-paths-v1");
  assert.equal(Object.keys(lock.files).length, 5);
});

test("lock generation can leave skipped user-owned files unlocked", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();

  const lock = await buildHarnessLock({ sourceRoot, targetRoot, excludePaths: [".codex/agents/runner.toml"] });

  assert.equal(lock.files[".codex/agents/runner.toml"], undefined);
  assert.equal(lock.files[".codex/harness.yaml"], undefined);
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

test("update discovers and installs decision schemas, CLI scripts, workflows, and source skills", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  const assets = {
    ".codex/schemas/decision/system-targets.schema.yaml": "schema_version: 1\nid: system-targets\n",
    ".codex/scripts/harness-decision-gate.mjs": "console.log('gate');\n",
    ".codex/workflows/spec-me.yaml": "schema_version: 1\nid: spec-me\n",
    ".codex/skills/decision-targets/SKILL.md": "# decision targets\n",
  };
  for (const [path, content] of Object.entries(assets)) {
    const sourcePath = join(sourceRoot, path);
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, content, "utf8");
  }

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.added, [
    ".agents/skills/decision-targets/SKILL.md",
    ".codex/schemas/decision/system-targets.schema.yaml",
    ".codex/scripts/harness-decision-gate.mjs",
    ".codex/workflows/spec-me.yaml",
  ]);
  assert.equal(await readFile(join(targetRoot, ".agents/skills/decision-targets/SKILL.md"), "utf8"), "# decision targets\n");
  assert.equal(await readFile(join(targetRoot, ".codex/schemas/decision/system-targets.schema.yaml"), "utf8"), assets[".codex/schemas/decision/system-targets.schema.yaml"]);
  assert.equal(await readFile(join(targetRoot, ".codex/scripts/harness-decision-gate.mjs"), "utf8"), assets[".codex/scripts/harness-decision-gate.mjs"]);
  assert.equal(await readFile(join(targetRoot, ".codex/workflows/spec-me.yaml"), "utf8"), assets[".codex/workflows/spec-me.yaml"]);
});

test("update skips installation into a recognized Harness source checkout worktree", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const packageJson = `${JSON.stringify({ name: "@example/harness-codex" })}\n`;
  await Promise.all([
    writeFile(join(sourceRoot, "package.json"), packageJson, "utf8"),
    writeFile(join(targetRoot, "package.json"), packageJson, "utf8"),
  ]);
  for (const relativePath of ["bin/harness-install.mjs", "src/installer/update.mjs", ".codex/skills/spec-me/SKILL.md"]) {
    const path = join(targetRoot, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "source checkout marker\n", "utf8");
  }

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.skipped, [{ path: ".codex", status: "source_checkout" }]);
  await assert.rejects(() => readFile(join(targetRoot, ".codex/harness-lock.json")), { code: "ENOENT" });
});

test("update installs project-local runtime scripts and tracks them as owned", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await writeFile(join(sourceRoot, ".codex", "scripts", "harness-workspace-preflight.mjs"), "console.log('ready');\n", "utf8");

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.added, [".codex/scripts/harness-workspace-preflight.mjs"]);
  assert.equal(await readFile(join(targetRoot, ".codex", "scripts", "harness-workspace-preflight.mjs"), "utf8"), "console.log('ready');\n");
  const lock = await buildHarnessLock({ sourceRoot, targetRoot });
  assert.ok(lock.files[".codex/scripts/harness-workspace-preflight.mjs"]);
});

test("update installs the plans index lifecycle gate for consumer projects", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  const gate = "export function inspectPlansIndex() { return { status: 'pass' }; }\n";
  await writeFile(join(sourceRoot, ".codex", "scripts", "plans-index-gate.mjs"), gate, "utf8");

  const result = await updateProject({ sourceRoot, targetRoot });

  assert.deepEqual(result.added, [".codex/scripts/plans-index-gate.mjs"]);
  assert.equal(await readFile(join(targetRoot, ".codex", "scripts", "plans-index-gate.mjs"), "utf8"), gate);
  const lock = await buildHarnessLock({ sourceRoot, targetRoot });
  assert.ok(lock.files[".codex/scripts/plans-index-gate.mjs"]);
});

test("fresh installation includes the runtime required by the decision gate CLI", async () => {
  const targetRoot = await mkdtemp(join(tmpdir(), "harness-runtime-install-"));
  try {
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const targets = {
      schema_version: 1,
      id: "system-targets",
      system_characteristics: {
        interaction: "CLI workflow.",
        workload: "On-demand checks.",
        state: "Project-local YAML.",
        consistency: "Atomic file replacement.",
        availability: "Node.js during command execution.",
        growth: "No expected service traffic.",
      },
      initial: [],
      expected_growth: [],
      architecture_boundary: [],
    };
    await writeSystemTargets({ root: targetRoot, ticketId: "514", targets });

    const runtimePath = join(targetRoot, ".codex", "harness-runtime", "src", "workflow", "stage-gates.mjs");
    assert.match(await readFile(runtimePath, "utf8"), /evaluateSystemTargetsComplete/);
    const lock = await buildHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(lock.files[".codex/harness-runtime/src/workflow/stage-gates.mjs"]);
    const result = spawnSync(process.execPath, [join(targetRoot, ".codex", "scripts", "harness-decision-gate.mjs"), "system_targets_complete", "--ticket", "514"], { cwd: targetRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "pass");

    const knowledgeCli = spawnSync(process.execPath, [join(targetRoot, ".codex", "scripts", "harness-knowledge.mjs")], { cwd: targetRoot, encoding: "utf8" });
    assert.equal(knowledgeCli.status, 1);
    assert.match(knowledgeCli.stderr, /Usage: harness-knowledge\.mjs/);
    assert.doesNotMatch(knowledgeCli.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});
