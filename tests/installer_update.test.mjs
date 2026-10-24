import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildHarnessLock, updateProject, writeHarnessLock } from "../src/installer/update.mjs";
import { protectLocalInstallArtifacts } from "../src/installer/local-exclude.mjs";
import { writeSystemTargets } from "../src/decision/artifacts.mjs";
import { runDoctor } from "../src/doctor/index.mjs";
import { makeContractsFixture } from "./contracts-fixture.mjs";
import { sessionOutputPath } from "../src/workflow/session-output.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("fresh and updated consumer review CLI enforces admission and preserves Git visibility", async () => {
  const targetRoot = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), 'review-install-'));
  const runtimePath = '.codex/harness-runtime/src/workflow/review-attempts.mjs';
  try {
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: targetRoot }).status, 0);
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    await protectLocalInstallArtifacts(targetRoot, REPOSITORY_ROOT);
    const spec = join(targetRoot, 'docs/specs/review-install');
    await mkdir(spec, { recursive: true });
    for (const file of ['request.md', 'product-spec.md', 'architecture-spec.md']) await writeFile(join(spec, file), 'Application-owned specification\n');
    const cli = (action, ...args) => spawnSync(process.execPath, [join(targetRoot, '.codex/scripts/harness-spec-review.mjs'), action, '--root', targetRoot, '--ticket', 'review-install', ...args], { cwd: targetRoot, encoding: 'utf8' });
    const architecture = cli('begin', '--axis', 'architecture');
    assert.equal(architecture.status, 1);
    assert.match(architecture.stderr, /Product review must pass/);
    const started = cli('begin', '--axis', 'product');
    assert.equal(started.status, 0, started.stderr);
    const attempt = JSON.parse(started.stdout);
    assert.match(cli('begin', '--axis', 'product').stderr, /already active/);
    const reviews = { product: { axis: 'product', ticket_id: 'review-install', reviewer_id: 'fresh-product-reviewer', author_ids: ['writer'], fork_turns: 'none', verdict: 'pass', inputs: attempt.inputs, findings: [] } };
    const evidence = 'runtime/spec-reviews/install.json';
    await writeFile(sessionOutputPath(targetRoot, evidence), JSON.stringify(reviews));
    assert.equal(cli('record', '--axis', 'product', '--attempt', attempt.attempt_id, '--reviews', evidence).status, 0);
    assert.equal(cli('check', '--axis', 'product', '--reviews', evidence).status, 0);
    assert.equal(cli('begin', '--axis', 'architecture', '--reviews', evidence).status, 0);

    const reviewInput = { repository: targetRoot, fixed_point: 'base', implementation_commit_sha: 'impl-1', commit_list: ['base', 'impl-1'], diff_range: { from: 'base', to: 'impl-1' }, diff: 'diff --git a/src/a b/src/a', product_spec_path: 'docs/specs/review-install/product-spec.md', architecture_spec_path: 'docs/specs/review-install/architecture-spec.md' };
    const implementationEvidence = 'runtime/spec-reviews/implementation.json';
    const implementationReviews = ['standards', 'spec'].map((role) => ({ role, state: role === 'standards' ? 'failed' : 'passed', context_id: role, independent: true, fresh_context: true, implementation_commit_sha: 'impl-1', review_input: reviewInput, report: { findings: role === 'standards' ? [{ kind: 'implementation_defect', summary: 'Repair the complete replay path' }] : [] } }));
    await writeFile(sessionOutputPath(targetRoot, implementationEvidence), JSON.stringify({ review_input: reviewInput, reviews: implementationReviews }));
    const repair = () => spawnSync(process.execPath, [join(targetRoot, '.codex/scripts/harness-code-review.mjs'), 'repair', '--root', targetRoot, '--plan', 'plan-a', '--reviews', implementationEvidence], { cwd: targetRoot, encoding: 'utf8' });
    assert.equal(repair().status, 0);
    assert.match(repair().stderr, /already has a reserved repair/);

    await writeFile(join(targetRoot, runtimePath), 'old runtime\n');
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const update = await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(update.updated.includes(runtimePath));
    assert.equal(cli('check', '--axis', 'product', '--reviews', evidence).status, 0);
    assert.match(cli('begin', '--axis', 'architecture', '--reviews', evidence).stderr, /already active/);
    assert.match(repair().stderr, /already has a reserved repair/);
    const lock = await buildHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(lock.files[runtimePath]);
    assert.ok(lock.files['.codex/scripts/harness-code-review.mjs']);
    const doctor = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(!doctor.diagnostics.some((item) => item.severity === 'error' && item.path.endsWith('review-attempts.mjs')));
    const status = spawnSync('git', ['status', '--short', '--untracked-files=all'], { cwd: targetRoot, encoding: 'utf8' }).stdout;
    assert.match(status, /docs\/specs\/review-install\/request.md/);
    assert.doesNotMatch(status, /\.codex\/|\.agents\/|runtime\/reviews/);
    assert.equal(await readFile(join(spec, 'request.md'), 'utf8'), 'Application-owned specification\n');
  } finally { await rm(targetRoot, { recursive: true, force: true }); }
});

test("recovery skill survives fresh install, diagnosed loss and update while project files remain visible", async () => {
  const targetRoot = await mkdtemp(join(process.env.HARNESS_SESSION_DIR || tmpdir(), "recovery-install-"));
  const skillPath = ".agents/skills/harness-recover/SKILL.md";
  try {
    assert.equal(spawnSync("git", ["init", "-q"], { cwd: targetRoot }).status, 0);
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot, initialize: true });
    await protectLocalInstallArtifacts(targetRoot, REPOSITORY_ROOT);
    const expected = (await readFile(join(REPOSITORY_ROOT, ".codex/skills/harness-recover/SKILL.md"), "utf8")).replaceAll(".codex/skills/", ".agents/skills/");
    assert.equal(await readFile(join(targetRoot, skillPath), "utf8"), expected);
    const docs = ["docs/agents/EXEC.md", "docs/agents/execution.json", "docs/contracts/product.md"];
    for (const path of docs) {
      await mkdir(dirname(join(targetRoot, path)), { recursive: true });
      await writeFile(join(targetRoot, path), "Application-owned preparation\n");
    }
    await unlink(join(targetRoot, skillPath));
    const broken = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(broken.diagnostics.some((item) => item.code === "installer_missing_file" && item.path === join(targetRoot, skillPath)));
    const updated = await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(updated.updated.includes(skillPath) || updated.added.includes(skillPath));
    assert.equal(await readFile(join(targetRoot, skillPath), "utf8"), expected);
    const lock = await buildHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(lock.files[skillPath]);
    const healthy = await runDoctor({ root: targetRoot, sourceRoot: REPOSITORY_ROOT });
    assert.ok(!healthy.diagnostics.some((item) => item.path === join(targetRoot, skillPath)));
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: targetRoot, encoding: "utf8" }).stdout;
    assert.doesNotMatch(status, /\.agents\/|\.codex\/|\.harness\//);
    assert.equal(spawnSync("git", ["check-ignore", "-v", skillPath], { cwd: targetRoot }).status, 0);
    for (const path of docs) {
      assert.ok(status.includes(path));
      assert.equal(spawnSync("git", ["check-ignore", "-v", path], { cwd: targetRoot }).status, 1);
      assert.equal(await readFile(join(targetRoot, path), "utf8"), "Application-owned preparation\n");
    }
  } finally { await rm(targetRoot, { recursive: true, force: true }); }
});

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
    const implementSkill = join(targetRoot, ".codex/internal-skills/implement/GUIDE.md");
    const completionModule = join(targetRoot, ".codex/harness-runtime/src/workflow/completion.mjs");
    const completionSource = await readFile(join(REPOSITORY_ROOT, "src/workflow/completion.mjs"), "utf8");
    await writeFile(completionModule, "export const staleCompletion = true;\n");
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    const completionUpdate = await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(completionUpdate.updated.includes(".codex/harness-runtime/src/workflow/completion.mjs"));
    assert.equal(await readFile(completionModule, "utf8"), completionSource);
    const internalRelativePath = ".agents/skills/spec-me/references/decision-knowledge.md";
    const internalSkill = join(targetRoot, internalRelativePath);
    const internalSource = await readFile(join(REPOSITORY_ROOT, ".codex/skills/spec-me/references/decision-knowledge.md"), "utf8");
    assert.equal(await readFile(internalSkill, "utf8"), internalSource);
    const specSkill = await readFile(join(targetRoot, ".agents/skills/spec-me/SKILL.md"), "utf8");
    const architectureReference = join(targetRoot, ".agents/skills/spec-me/references/architecture-decision.md");
    assert.equal(await readFile(architectureReference, "utf8"), await readFile(join(REPOSITORY_ROOT, ".codex/skills/spec-me/references/architecture-decision.md"), "utf8"));
    const productGuide = join(targetRoot, ".codex/internal-skills/product-spec/GUIDE.md");
    assert.equal(await readFile(productGuide, "utf8"), await readFile(join(REPOSITORY_ROOT, ".codex/internal-skills/product-spec/GUIDE.md"), "utf8"));
    assert.ok(specSkill.includes("internal-skills/product-spec/GUIDE.md"));
    assert.ok(specSkill.includes("references/architecture-decision.md"));
    await assert.rejects(readFile(join(targetRoot, ".agents/skills/decision-knowledge/SKILL.md")), { code: "ENOENT" });
    await writeFile(internalSkill, "stale internal guidance\n");
    const distributionRule = /trace it through managed asset discovery and transforms, fresh installation, (?:and )?update/;
    assert.match(await readFile(implementSkill, "utf8"), distributionRule);
    await writeFile(implementSkill, "stale consumer copy\n");
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.equal(await readFile(internalSkill, "utf8"), internalSource);
    const internalLock = await buildHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot });
    assert.ok(internalLock.files[internalRelativePath]);
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

test("installed consumer creates an automatically identified owned worktree without hiding application changes", async () => {
  const { root, cleanup } = await makeContractsFixture();
  try {
    await protectLocalInstallArtifacts(root, REPOSITORY_ROOT);
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    const baseline = spawnSync("git", ["add", ".github/pull_request_template.md"], { cwd: root, encoding: "utf8" });
    assert.equal(baseline.status, 0, baseline.stderr);
    const baselineCommit = spawnSync("git", ["commit", "-m", "install consumer baseline"], { cwd: root, encoding: "utf8" });
    assert.equal(baselineCommit.status, 0, baselineCommit.stderr);
    const runtime = join(root, ".codex/harness-runtime/src/workflow/worktrees.mjs");
    const source = await readFile(join(REPOSITORY_ROOT, "src/workflow/worktrees.mjs"), "utf8");
    await writeFile(runtime, "export const staleRuntime = true;\n");
    await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    const updated = await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
    assert.ok(updated.updated.includes(".codex/harness-runtime/src/workflow/worktrees.mjs"));
    assert.equal(await readFile(runtime, "utf8"), source);

    const cli = join(root, ".codex/scripts/harness-workflow-worktree.mjs");
    const created = spawnSync(process.execPath, [cli, "create", "--root", root], { cwd: root, encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const handle = JSON.parse(created.stdout);
    assert.match(handle.worktree_id, /^[0-9a-f-]{36}$/);
    assert.equal(handle.source_workspace, root);
    assert.notEqual(handle.workspace, root);
    assert.equal(handle.state, "active");
    assert.doesNotMatch(created.stdout, /workflow_id/);
    const sessionRecord = JSON.parse(await readFile(join(handle.session_directory, "worktree.json"), "utf8"));
    assert.equal(sessionRecord.worktree_id, handle.worktree_id);
    const preflight = spawnSync(process.execPath, [join(root, ".codex/scripts/harness-workspace-preflight.mjs"), "--workspace-root", handle.workspace, "--json"], { cwd: handle.workspace, encoding: "utf8" });
    assert.equal(preflight.status, 0, preflight.stderr);
    assert.equal(JSON.parse(preflight.stdout).is_linked_worktree, true);

    const unrelatedSession = join(root, ".git/harness-workflows/sessions", "f".repeat(64));
    await mkdir(unrelatedSession, { recursive: true });
    await writeFile(join(unrelatedSession, "receipt.json"), JSON.stringify({ schema_version: 1, workflow_id: "execution-run", state: "completed" }));
    const activeList = spawnSync(process.execPath, [cli, "list", "--root", root], { cwd: root, encoding: "utf8" });
    assert.equal(activeList.status, 0, activeList.stderr);
    assert.deepEqual(JSON.parse(activeList.stdout).map(({ worktree_id }) => worktree_id), [handle.worktree_id]);

    const finished = spawnSync(process.execPath, [cli, "finish", "--root", handle.workspace, "--repository", root, "--worktree-id", handle.worktree_id, "--outcome", "completed"], { cwd: root, encoding: "utf8" });
    assert.equal(finished.status, 0, finished.stderr);
    assert.equal(JSON.parse(finished.stdout).state, "removed");
    const remaining = spawnSync(process.execPath, [cli, "list", "--root", root], { cwd: root, encoding: "utf8" });
    assert.equal(remaining.status, 0, remaining.stderr);
    assert.deepEqual(JSON.parse(remaining.stdout), []);
    assert.match(spawnSync("git", ["branch", "--list", handle.branch], { cwd: root, encoding: "utf8" }).stdout, new RegExp(handle.branch));

    await writeFile(join(root, "src/app.mjs"), "export const app = 'user change';\n");
    const status = spawnSync("git", ["status", "--short", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(status.stdout.trimEnd().split("\n"), [" M src/app.mjs"]);
  } finally { await cleanup(); }
});

test("updated consumer defers only source snapshot drift until final contract synchronization", async (t) => {
  const { root, cleanup } = await makeContractsFixture();
  t.after(cleanup);
  await mkdir(join(root, "docs/agents"), { recursive: true });
  await writeFile(join(root, "docs/agents/EXEC.md"), "Execution instructions\n");
  await writeFile(join(root, "docs/agents/execution.json"), JSON.stringify({ schema_version: 1, profiles: { focused: { command: ["node", "-e", "process.exit(0)"], required_env: [], config_inputs: ["docs/agents/execution.json"], prepare: [["node", "-e", "process.exit(0)"]], verify_config: [["node", "-e", "process.exit(0)"]], dependencies: [], timeout_ms: 1000, readiness_timeout_ms: 100, poll_interval_ms: 10 } } }));
  await writeFile(join(root, "src/app.mjs"), "export const app = 'changed after contract seal';\n");
  await writeHarnessLock({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });
  await updateProject({ sourceRoot: REPOSITORY_ROOT, targetRoot: root });

  const { inspectProjectReadiness } = await import(pathToFileURL(join(root, ".codex/harness-runtime/src/workflow/project-readiness.mjs")));
  const deferred = await inspectProjectReadiness({ workspace_root: root, deferContractSync: true });
  assert.equal(deferred.status, "pass", JSON.stringify(deferred));
  assert.equal(deferred.contract_sync.status, "deferred");
  const preflight = spawnSync(process.execPath, [join(root, ".codex/scripts/harness-workspace-preflight.mjs"), "--workspace-root", root, "--for-implementation", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
  assert.equal(JSON.parse(preflight.stdout).contract_sync.status, "deferred");

  await writeFile(join(root, "docs/contracts/manifest.json"), "{");
  const invalid = await inspectProjectReadiness({ workspace_root: root, deferContractSync: true });
  assert.equal(invalid.status, "blocked");
  assert.notEqual(invalid.contract_sync?.status, "deferred");
  const invalidPreflight = spawnSync(process.execPath, [join(root, ".codex/scripts/harness-workspace-preflight.mjs"), "--workspace-root", root, "--for-implementation", "--json"], { cwd: root, encoding: "utf8" });
  assert.equal(invalidPreflight.status, 1);
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

test("VictoriaLogs replacement backs up and retires only the managed SigNoz skill", async () => {
  const { sourceRoot, targetRoot } = await makeSourceAndTarget();
  const retired = '.agents/skills/signoz-local-setup/SKILL.md';
  const source = join(sourceRoot, '.codex/skills/signoz-local-setup/SKILL.md');
  await mkdir(dirname(source), { recursive: true });
  await mkdir(dirname(join(targetRoot, retired)), { recursive: true });
  await writeFile(source, '# old setup\n');
  await writeFile(join(targetRoot, retired), '# project modified old setup\n');
  await writeHarnessLock({ sourceRoot, targetRoot });
  await unlink(source);
  const result = await updateProject({ sourceRoot, targetRoot });
  assert.deepEqual(result.retired, [retired]);
  await assert.rejects(readFile(join(targetRoot, retired)), { code: 'ENOENT' });
  assert.equal(await readFile(join(result.backup_directory, retired), 'utf8'), '# project modified old setup\n');
  assert.equal(result.lock.files[retired], undefined);
  assert.equal(await readFile(join(targetRoot, '.agents/skills/alpha/SKILL.md'), 'utf8'), '# alpha\n');
});
