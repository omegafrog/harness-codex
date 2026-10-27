import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { runDoctor } from "../src/doctor/index.mjs";
import { protectLocalInstallArtifacts } from "../src/installer/local-exclude.mjs";

import { updateProject } from "../src/installer/update.mjs";
import { discoverHarnessOwnedFiles } from "../src/installer/lock.mjs";
import { loadNamedWorkflow } from "../src/workflow/index.mjs";

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("internal skills reach installed workflows without public skill entrypoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-internal-consumer-"));
  try {
    await updateProject({ sourceRoot: SOURCE, targetRoot: root, initialize: true });
    await writeFile(join(root, ".codex/harness.yaml"), "agents:\n  execution_model: installed-runner\n  execution_reasoning_effort: low\n");
    const binding = spawnSync(process.execPath, [join(root, ".codex/scripts/harness-skill-execution.mjs"), "binding", "--root", root, "--skill", "e2e-test"], { cwd: root, encoding: "utf8" });
    assert.equal(binding.status, 0, binding.stderr);
    assert.equal(JSON.parse(binding.stdout).model, "installed-runner");
    assert.equal(JSON.parse(binding.stdout).reasoning_effort, "low");
    const { validateSkillReturn } = await import(pathToFileURL(join(root, ".codex/harness-runtime/src/workflow/skill-execution.mjs")));
    const { validateSpecReviewAdmission } = await import(pathToFileURL(join(root, ".codex/harness-runtime/src/workflow/spec-review.mjs")));
    await assert.rejects(validateSpecReviewAdmission({ root, admission: {} }), /Invalid review admission target/);
    const { validateEvidence } = await import(pathToFileURL(join(root, ".codex/harness-runtime/src/knowledge/validation.mjs")));
    const documentary = { schema_version: 1, id: "doc-evidence", origin_project: "consumer", environment: { scope: "local" }, timestamp: "2026-10-27T00:00:00Z", type: "documentary", execution_status: "not_applicable", measurement_validity: "not_applicable", execution_purpose: "decision_validation", observations: [{ metric: "scope", value: "one player", unit: "constraint" }], source_reference: "product.md#REQ-1", source_sha256: "a".repeat(64), decision_ids: ["decision-one"], summary: "One player is required." };
    assert.equal(validateEvidence(documentary).valid, true);
    assert.equal(validateEvidence({ ...documentary, source_sha256: undefined }).valid, false);
    const { sessionDirectory, sessionOutputPath } = await import(pathToFileURL(join(root, ".codex/harness-runtime/src/workflow/session-output.mjs")));
    const input = { schema_version: 1, execution_id: "installed-output", skill: "product-spec", workspace_root: root, shared_guidance_root: root, session_directory: sessionDirectory(root), scope: "Write Product", input_refs: [], context: { outputs: [{ id: "product_spec", description: "Product" }] } };
    const envelope = { schema_version: 1, execution_id: input.execution_id, skill: input.skill, status: "completed", code: "OK", result_ref: `runtime/executions/${input.execution_id}/result.json` };
    await writeFile(join(root, "product.md"), "Product");
    const artifact = { kind: "product_spec", base: "workspace", path: "product.md" };
    const result = { ...envelope, summary: "Written", artifacts: [artifact, artifact], details: {} };
    delete result.result_ref;
    await writeFile(sessionOutputPath(root, envelope.result_ref), JSON.stringify(result));
    await assert.rejects(validateSkillReturn({ root, input, envelope }), /one artifact with kind=product_spec/);
    result.artifacts.pop();
    await writeFile(sessionOutputPath(root, envelope.result_ref), JSON.stringify(result));
    assert.equal((await validateSkillReturn({ root, input, envelope })).valid, true);
    await rm(join(root, ".codex/harness.yaml"));
    const { buildImplementPrompt } = await import(pathToFileURL(join(root, ".codex/harness-runtime/src/wrapper/scheduler.mjs")));
    for (const mode of ["sequential", "parallel"]) {
      const prompt = buildImplementPrompt({ repository: root, planSetId: "example", planId: "slice", workspaceMode: mode });
      const selected = join(root, `.codex/internal-skills/session-worktree/references/${mode}.md`);
      assert.ok(prompt.includes(`workspace_mode: ${mode}`));
      assert.ok(prompt.includes(`workspace_reference: ${selected}`));
      assert.equal(prompt.includes(`references/${mode === "sequential" ? "parallel" : "sequential"}.md`), false);
      await readFile(selected);
    }
    assert.throws(() => buildImplementPrompt({ repository: root, planSetId: "example", planId: "slice", workspaceMode: "unknown" }), /workspaceMode/);
    const names = await readdir(join(SOURCE, ".codex/internal-skills"));
    const owned = await discoverHarnessOwnedFiles(root);
    for (const name of names) {
      const relative = `.codex/internal-skills/${name}/GUIDE.md`;
      assert.ok(owned.includes(relative), name);
      await assert.rejects(readFile(join(root, `.agents/skills/${name}/SKILL.md`)), { code: "ENOENT" });
      const source = await readFile(join(SOURCE, relative), "utf8");
      assert.equal(await readFile(join(root, relative), "utf8"), source.replaceAll(".codex/skills/", ".agents/skills/"));
    }
    for (const name of ["spec-me", "to-ticket", "implement-wrapper", "frontend-design", "knowledge-harvest-workflow"]) {
      const workflow = await loadNamedWorkflow(name, { root });
      for (const [skill, path] of Object.entries(workflow.references.skills)) {
        if (names.includes(skill)) assert.equal(path, join(root, `.codex/internal-skills/${skill}/GUIDE.md`));
      }
    }
    // Cross-boundary links must resolve from the installed tree as well as the source.
    for (const relative of owned.filter((path) => path.endsWith("/GUIDE.md") || path.endsWith("/SKILL.md") || path.startsWith(".codex/internal-skills/session-worktree/references/"))) {
      const text = await readFile(join(root, relative), "utf8");
      for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || target.includes("://") || target.includes("<") || target.startsWith("/")) continue;
        const path = resolve(root, dirname(relative), target);
        if (path.startsWith(join(root, ".codex/internal-skills/")) || path.startsWith(join(root, ".agents/skills/"))) await readFile(path);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("internal skill migration backs up and removes managed public copies on skills-only update", async () => {
  const source = await mkdtemp(join(tmpdir(), "harness-internal-source-"));
  const target = await mkdtemp(join(tmpdir(), "harness-internal-target-"));
  try {
    const oldDirectory = join(source, ".codex/skills/helper");
    await mkdir(join(oldDirectory, "references"), { recursive: true });
    await writeFile(join(oldDirectory, "SKILL.md"), "old public helper\n");
    await writeFile(join(oldDirectory, "references/rule.md"), "old rule\n");
    await updateProject({ sourceRoot: source, targetRoot: target, initialize: true });
    await writeFile(join(target, ".agents/skills/helper/SKILL.md"), "local helper edits\n");
    await rm(oldDirectory, { recursive: true });
    const internal = join(source, ".codex/internal-skills/helper");
    await mkdir(join(internal, "references"), { recursive: true });
    await writeFile(join(internal, "GUIDE.md"), "internal helper\n");
    await writeFile(join(internal, "references/rule.md"), "internal rule\n");
    const agentsOnly = await updateProject({ sourceRoot: source, targetRoot: target, scope: "agents" });
    assert.ok(agentsOnly.lock.files[".agents/skills/helper/SKILL.md"]);
    assert.equal(await readFile(join(target, ".agents/skills/helper/SKILL.md"), "utf8"), "local helper edits\n");
    const result = await updateProject({ sourceRoot: source, targetRoot: target, scope: "skills" });
    assert.deepEqual(result.skipped, []);
    for (const path of [".agents/skills/helper/SKILL.md", ".agents/skills/helper/references/rule.md"]) {
      await assert.rejects(readFile(join(target, path)), { code: "ENOENT" });
      assert.ok(result.retired.includes(path));
      assert.equal(result.lock.files[path], undefined);
    }
    assert.equal(await readFile(join(result.backup_directory, ".agents/skills/helper/SKILL.md"), "utf8"), "local helper edits\n");
    assert.equal(await readFile(join(target, ".codex/internal-skills/helper/GUIDE.md"), "utf8"), "internal helper\n");
    assert.ok(result.lock.files[".codex/internal-skills/helper/GUIDE.md"]);
    const repeated = await updateProject({ sourceRoot: source, targetRoot: target });
    assert.deepEqual(repeated.updated, []);
    assert.deepEqual(repeated.added, []);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});


test("fresh and updated consumers receive the existing-root implementation policy without hiding application changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-implementation-policy-"));
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const paths = [
    ...["orchestrator/SKILL.md", "orchestrator/agents/openai.yaml", "implement-wrapper/SKILL.md", "spec-me/SKILL.md", "spec-me/references/adversarial-spec-review.md", "code-review/SKILL.md", "to-ticket/SKILL.md", "to-ticket/references/execution-evidence.md", "to-ticket/references/github-issue-template.md"].map((path) => [`.codex/skills/${path}`, `.agents/skills/${path}`]),
    ...["sequential", "parallel", "worktree-cli"].map((name) => {
      const path = `.codex/internal-skills/session-worktree/references/${name}.md`;
      return [path, path];
    }),
    ...["implement", "session-worktree", "worktree-create", "sync-contracts", "spec-review", "plan-review", "review-coordination", "skill-execution"].map((name) => {
      const path = `.codex/internal-skills/${name}/GUIDE.md`;
      return [path, path];
    }),
    ...["bindings.json", "schemas/input.schema.json", "schemas/result.schema.json", "schemas/return.schema.json"].map((name) => {
      const path = `.codex/internal-skills/skill-execution/${name}`;
      return [path, path];
    }),
  ];
  const legacyCoordination = ".codex/internal-skills/spec-review/references/review-coordination.md";
  const coordination = ".codex/internal-skills/review-coordination/GUIDE.md";
  const budgetPath = ".codex/context-budget.json";
  const budget = JSON.stringify({ schema_version: 1, context_window_tokens: 100000, max_plan_tokens: 30000, handoff_reserve_tokens: 20000 });
  try {
    git("init", "--quiet");
    await writeFile(join(root, "app.txt"), "original application\n");
    git("add", "app.txt");
    git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "-m", "initial");
    await writeFile(join(root, "app.txt"), "application edit\n");
    await writeFile(join(root, "new-app.txt"), "new application file\n");
    const before = git("worktree", "list", "--porcelain");
    for (const operation of ["install", "update"]) {
      await protectLocalInstallArtifacts(root, SOURCE);
      if (operation === 'install') { await mkdir(join(root, '.codex'), { recursive: true }); await writeFile(join(root, budgetPath), budget); }
      const updated = await updateProject({ sourceRoot: SOURCE, targetRoot: root, initialize: operation === "install", scope: "skills" });
      await assert.rejects(readFile(join(root, legacyCoordination)), { code: "ENOENT" });
      if (operation === "update") assert.ok(updated.retired.includes(legacyCoordination));
      const inventory = await discoverHarnessOwnedFiles(root);
      const lock = JSON.parse(await readFile(join(root, ".codex/harness-lock.json"), "utf8"));
      assert.equal(lock.files[budgetPath], undefined);
      assert.equal(await readFile(join(root, budgetPath), 'utf8'), budget);
      for (const [source, target] of paths) {
        assert.equal(await readFile(join(root, target), "utf8"), (await readFile(join(SOURCE, source), "utf8")).replaceAll(".codex/skills/", ".agents/skills/"));
        assert.ok(inventory.includes(target), target);
        assert.ok(lock.files[target], target);
      }
      const doctor = await runDoctor({ root, sourceRoot: SOURCE });
      assert.equal(doctor.diagnostics.some((item) => paths.some(([, target]) => item.path.endsWith(target))), false, JSON.stringify(doctor.diagnostics));
      assert.equal(git("worktree", "list", "--porcelain"), before);
      assert.equal(git("status", "--short", "--untracked-files=all"), " M app.txt\n?? new-app.txt\n");
      assert.equal(await readFile(join(root, "app.txt"), "utf8"), "application edit\n");
      if (operation === "install") {
        await mkdir(dirname(join(root, legacyCoordination)), { recursive: true });
        await writeFile(join(root, legacyCoordination), await readFile(join(SOURCE, coordination), "utf8"));
        lock.files[legacyCoordination] = { ...lock.files[coordination], source_path: legacyCoordination };
        await writeFile(join(root, ".codex/harness-lock.json"), JSON.stringify(lock));
        for (const [, target] of paths) await writeFile(join(root, target), "stale implementation policy\n");
        const stale = await runDoctor({ root, sourceRoot: SOURCE });
        for (const [, target] of paths) assert.ok(stale.diagnostics.some((item) => item.path.endsWith(target)), target);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
