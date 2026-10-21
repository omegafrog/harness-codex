import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildHarnessLock, updateProject, writeHarnessLock } from "../src/installer/update.mjs";
import { writeSystemTargets } from "../src/decision/artifacts.mjs";
import { runDoctor } from "../src/doctor/index.mjs";

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

test("update deploys skill references and backs up their local conflict edits", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const sourcePath = join(sourceRoot, ".codex/skills/alpha/references/model.md");
  const targetPath = join(targetRoot, ".agents/skills/alpha/references/model.md");
  try {
    await writeHarnessLock({ sourceRoot, targetRoot });
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, "upstream v1\n");
    const added = await updateProject({ sourceRoot, targetRoot });
    assert.ok(added.added.includes(".agents/skills/alpha/references/model.md"));
    assert.equal(await readFile(targetPath, "utf8"), "upstream v1\n");
    await writeFile(sourcePath, "upstream v2\n");
    await updateProject({ sourceRoot, targetRoot });
    assert.equal(await readFile(targetPath, "utf8"), "upstream v2\n");
    await writeFile(targetPath, "local model\n");
    await writeFile(sourcePath, "upstream v3\n");
    const updated = await updateProject({ sourceRoot, targetRoot });
    assert.ok(updated.updated.includes(".agents/skills/alpha/references/model.md"));
    assert.equal(await readFile(targetPath, "utf8"), "upstream v3\n");
    assert.equal(await readFile(join(updated.backup_directory, ".agents/skills/alpha/references/model.md"), "utf8"), "local model\n");
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
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
    const implementSkill = join(targetRoot, ".agents/skills/implement/SKILL.md");
    const distributionRule = /trace it through managed asset discovery and transforms, fresh installation, and update/;
    assert.match(await readFile(implementSkill, "utf8"), distributionRule);
    await writeFile(implementSkill, "stale consumer copy\n");
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.match(await readFile(implementSkill, "utf8"), distributionRule);
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

    const trackerRuntime = join(targetRoot, ".codex", "harness-runtime", "src", "tracker", "lifecycle.mjs");
    assert.match(await readFile(trackerRuntime, "utf8"), /inspectTrackerSync/);
    const trackerCli = spawnSync(process.execPath, [join(targetRoot, ".codex", "scripts", "harness-tracker.mjs")], { cwd: targetRoot, encoding: "utf8" });
    assert.equal(trackerCli.status, 1);
    assert.match(trackerCli.stderr, /Usage: harness-tracker\.mjs/);
    assert.doesNotMatch(trackerCli.stderr, /ERR_MODULE_NOT_FOUND/);

    for (const module of ["src/workflow/worktrees.mjs", "src/workflow/completion.mjs"]) {
      await readFile(join(targetRoot, ".codex", "harness-runtime", module), "utf8");
    }
    for (const script of ["harness-workflow-worktree.mjs", "harness-workflow-complete.mjs"]) {
      const result = spawnSync(process.execPath, [join(targetRoot, ".codex", "scripts", script)], { cwd: targetRoot, encoding: "utf8" });
      assert.equal(result.status, 1);
      assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    }
  } finally {
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("update installs standalone contracts runtime and preserves a locally edited workflow", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  try {
    await mkdir(join(sourceRoot, "src/contracts"), { recursive: true });
    await mkdir(join(sourceRoot, ".github/workflows"), { recursive: true });
    await writeFile(join(sourceRoot, "src/contracts/contracts.mjs"), "export const runtime = true;\n");
    await writeFile(join(sourceRoot, ".github/workflows/harness-contracts.yml"), "name: contracts v1\n");
    await writeHarnessLock({ sourceRoot, targetRoot });
    const first = await updateProject({ sourceRoot, targetRoot });
    assert.ok(first.added.includes(".harness/contracts.mjs"));
    assert.ok(first.added.includes(".github/workflows/harness-contracts.yml"));
    assert.equal(await readFile(join(targetRoot, ".harness/contracts.mjs"), "utf8"), "export const runtime = true;\n");
    assert.equal(await readFile(join(targetRoot, ".github/workflows/harness-contracts.yml"), "utf8"), "name: contracts v1\n");

    await writeFile(join(targetRoot, ".codex/workflows/review.yaml"), "user workflow\n");
    await writeFile(join(sourceRoot, ".codex/workflows/review.yaml"), "schema_version: 1\nid: review\nversion: 2\n");
    const updated = await updateProject({ sourceRoot, targetRoot });
    assert.ok(updated.skipped.some((entry) => entry.path === ".codex/workflows/review.yaml" && entry.status === "conflict"));
    assert.equal(await readFile(join(targetRoot, ".codex/workflows/review.yaml"), "utf8"), "user workflow\n");
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});

test("install initializes a missing lock and updates are idempotent", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const first = await updateProject({ sourceRoot, targetRoot, initialize: true });
  assert.ok(first.lock.files[".codex/agents/runner.toml"]);
  const second = await updateProject({ sourceRoot, targetRoot });
  assert.deepEqual(second.updated, []);
  assert.deepEqual(second.added, []);
});

test("default updates replace and back up skill conflicts while preserving agent conflicts", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  const agent = join(targetRoot, ".codex/agents/runner.toml");
  const skill = join(targetRoot, ".agents/skills/alpha/SKILL.md");
  await writeFile(agent, "local agent\n");
  await writeFile(skill, "local skill\n");
  await writeFile(join(sourceRoot, ".codex/agents/runner.toml"), "upstream agent v2\n");
  await writeFile(join(sourceRoot, ".codex/skills/alpha/SKILL.md"), "upstream skill v2\n");

  const defaultUpdate = await updateProject({ sourceRoot, targetRoot });
  assert.equal(await readFile(agent, "utf8"), "local agent\n");
  assert.equal(await readFile(skill, "utf8"), "upstream skill v2\n");
  assert.ok(defaultUpdate.backup_directory);
  assert.equal(await readFile(join(defaultUpdate.backup_directory, ".agents/skills/alpha/SKILL.md"), "utf8"), "local skill\n");
  assert.ok(defaultUpdate.skipped.some((entry) => entry.path === ".codex/agents/runner.toml" && entry.status === "conflict"));
  await writeFile(skill, "local skill v3\n");
  await writeFile(join(sourceRoot, ".codex/skills/alpha/SKILL.md"), "upstream skill v3\n");
  const forced = await updateProject({ sourceRoot, targetRoot, force: true });
  assert.equal(await readFile(agent, "utf8"), "upstream agent v2\n");
  assert.equal(await readFile(skill, "utf8"), "upstream skill v3\n");
  assert.ok(forced.backup_directory);
  assert.equal(await readFile(join(forced.backup_directory, ".codex/agents/runner.toml"), "utf8"), "local agent\n");
  assert.equal(await readFile(join(forced.backup_directory, ".agents/skills/alpha/SKILL.md"), "utf8"), "local skill v3\n");
});

test("default install backs up managed skill collisions, preserves user skills, and avoids repeat backups", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const alpha = join(targetRoot, ".agents/skills/alpha/SKILL.md");
  const betaSource = join(sourceRoot, ".codex/skills/beta/SKILL.md");
  const betaTarget = join(targetRoot, ".agents/skills/beta/SKILL.md");
  const userSkill = join(targetRoot, ".agents/skills/personal/SKILL.md");
  await writeFile(alpha, "local-only edit\n");
  await mkdir(dirname(betaSource), { recursive: true });
  await mkdir(dirname(betaTarget), { recursive: true });
  await writeFile(betaSource, "upstream beta\n");
  await writeFile(betaTarget, "untracked user file\n");
  await mkdir(dirname(userSkill), { recursive: true });
  await writeFile(userSkill, "my skill\n");

  const first = await updateProject({ sourceRoot, targetRoot, initialize: true });
  assert.equal(await readFile(alpha, "utf8"), "# alpha\n");
  assert.equal(await readFile(join(first.backup_directory, ".agents/skills/alpha/SKILL.md"), "utf8"), "local-only edit\n");
  assert.equal(await readFile(betaTarget, "utf8"), "upstream beta\n");
  assert.equal(await readFile(join(first.backup_directory, ".agents/skills/beta/SKILL.md"), "utf8"), "untracked user file\n");
  assert.equal(await readFile(userSkill, "utf8"), "my skill\n");

  const second = await updateProject({ sourceRoot, targetRoot });
  assert.equal(second.backup_directory, null);
  assert.deepEqual(second.updated, []);
  assert.deepEqual(second.added, []);
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(targetRoot, { recursive: true, force: true });
});

test("update adds the PR template, preserves an existing one, and backs it up on force", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const sourceTemplate = join(sourceRoot, ".github/pull_request_template.md");
  const targetTemplate = join(targetRoot, ".github/pull_request_template.md");
  await mkdir(dirname(sourceTemplate), { recursive: true });
  await writeFile(sourceTemplate, "upstream PR template\n");
  await writeHarnessLock({ sourceRoot, targetRoot });
  const added = await updateProject({ sourceRoot, targetRoot });
  assert.ok(added.added.includes(".github/pull_request_template.md"));
  await writeFile(targetTemplate, "local PR template\n");
  await writeFile(sourceTemplate, "upstream PR template v2\n");
  await updateProject({ sourceRoot, targetRoot });
  assert.equal(await readFile(targetTemplate, "utf8"), "local PR template\n");
  const forced = await updateProject({ sourceRoot, targetRoot, force: true });
  assert.equal(await readFile(targetTemplate, "utf8"), "upstream PR template v2\n");
  assert.equal(await readFile(join(forced.backup_directory, ".github/pull_request_template.md"), "utf8"), "local PR template\n");
});

test("reinstall initializes a missing lock without replacing project config", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeFile(join(targetRoot, ".codex/harness.yaml"), "user config\n");
  await updateProject({ sourceRoot, targetRoot, initialize: true });
  await updateProject({ sourceRoot, targetRoot, initialize: true });
  assert.equal(await readFile(join(targetRoot, ".codex/harness.yaml"), "utf8"), "user config\n");
});

test("retired managed files leave the lock and partial scope retains other baselines", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  await unlink(join(sourceRoot, ".codex/schemas/case.yaml"));
  await writeFile(join(targetRoot, ".codex/workflows/review.yaml"), "local workflow\n");
  const retired = await updateProject({ sourceRoot, targetRoot });
  let lock = JSON.parse(await readFile(join(targetRoot, ".codex/harness-lock.json"), "utf8"));
  assert.equal(lock.files[".codex/schemas/case.yaml"], undefined);
  assert.ok(retired.removed_lock_entries.includes(".codex/schemas/case.yaml"));
  const previousWorkflowBaseline = lock.files[".codex/workflows/review.yaml"].installed_sha256;
  await writeFile(join(sourceRoot, ".codex/agents/runner.toml"), "agent v2\n");
  await updateProject({ sourceRoot, targetRoot, scope: "agents" });
  lock = JSON.parse(await readFile(join(targetRoot, ".codex/harness-lock.json"), "utf8"));
  assert.equal(lock.files[".codex/workflows/review.yaml"].installed_sha256, previousWorkflowBaseline);
});

test("update repairs a retired skill source mapping and backs up the local edit", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  await writeHarnessLock({ sourceRoot, targetRoot });
  const lockPath = join(targetRoot, ".codex/harness-lock.json");
  const skillTarget = join(targetRoot, ".agents/skills/alpha/SKILL.md");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  lock.files[".agents/skills/alpha/SKILL.md"].source_path = ".codex/skills/retired/SKILL.md";
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await writeFile(join(sourceRoot, ".codex/skills/alpha/SKILL.md"), "upstream v2\n");

  const vendorUpdate = await updateProject({ sourceRoot, targetRoot });
  assert.ok(vendorUpdate.updated.includes(".agents/skills/alpha/SKILL.md"));
  assert.equal(await readFile(skillTarget, "utf8"), "upstream v2\n");
  let repaired = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(repaired.files[".agents/skills/alpha/SKILL.md"].source_path, ".codex/skills/alpha/SKILL.md");

  await writeFile(lockPath, `${JSON.stringify({ ...repaired, files: { ...repaired.files, ".agents/skills/alpha/SKILL.md": { ...repaired.files[".agents/skills/alpha/SKILL.md"], source_path: ".codex/skills/retired/SKILL.md" } } }, null, 2)}\n`);
  await writeFile(skillTarget, "local edit\n");
  await writeFile(join(sourceRoot, ".codex/skills/alpha/SKILL.md"), "upstream v3\n");
  const repairedUpdate = await updateProject({ sourceRoot, targetRoot });
  assert.ok(repairedUpdate.updated.includes(".agents/skills/alpha/SKILL.md"));
  assert.equal(await readFile(skillTarget, "utf8"), "upstream v3\n");
  assert.equal(await readFile(join(repairedUpdate.backup_directory, ".agents/skills/alpha/SKILL.md"), "utf8"), "local edit\n");
  repaired = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(repaired.files[".agents/skills/alpha/SKILL.md"].source_path, ".codex/skills/alpha/SKILL.md");
  const report = await runDoctor({ root: targetRoot, lockPath: ".codex/harness-lock.json", sourceRoot });
  assert.equal(report.diagnostics.some((entry) => entry.code === "installer_source_missing"), false);
});

test("installed session output CLI resolves through the portable runtime", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  try {
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const cli = join(targetRoot, ".codex/scripts/harness-session-output.mjs");
    const result = spawnSync(process.execPath, [cli, "--root", targetRoot], { cwd: targetRoot, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /harness-workflows\/sessions\/[a-f0-9]{64}$/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/);
    assert.ok(await readFile(join(targetRoot, ".codex/harness-runtime/src/workflow/session-output.mjs"), "utf8"));
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
  }
});
