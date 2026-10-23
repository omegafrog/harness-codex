import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { WorktreeManager } from "../src/eval/plan-workspace.mjs";
import { PlanCheckpointStore } from "../src/wrapper/checkpoint.mjs";
import { dispatchImplementPlan, executeImplementPlan, resolveImplementationProfile, resolveReviewerProfile, runIndependentReviewers } from "../src/wrapper/dispatch.mjs";
import { ExecutionSlotRegistry, buildImplementPrompt } from "../src/wrapper/scheduler.mjs";
import { makeContractsFixture } from "./contracts-fixture.mjs";
import { sealContracts } from "../src/contracts/contracts.mjs";
import { sessionDirectory, sessionOutputPath } from "../src/workflow/session-output.mjs";
import { snapshotPlanTraceability } from "../src/workflow/plan-traceability.mjs";

const execFileAsync = promisify(execFile);

test("implementation prompt accepts canonical GitHub plans and separate ticket IDs", () => {
  const prompt = buildImplementPrompt({
    repository: process.cwd(),
    workspaceRoot: process.cwd(),
    planSetId: "plan-set",
    planId: "plan-a",
    planPath: "owner/repo#456",
    traceabilityRefs: {
      plan_reference: "owner/repo#456",
      ticket_id: "ticket-123",
      product_spec_path: "docs/specs/ticket-123/product-spec.md",
      architecture_spec_path: "docs/specs/ticket-123/architecture-spec.md",
      ledger_path: "docs/plans/plan-set/traceability.json",
      requirement_ids: ["BR-1"],
    },
  });
  assert.match(prompt, /Plan: owner\/repo#456/);
  assert.match(prompt, /Product Spec: docs\/specs\/ticket-123\/product-spec\.md/);
});

async function makeSessionTemp(prefix) {
  assert.ok(process.env.HARNESS_SESSION_DIR, "Run this test through harness-exec");
  const directory = sessionOutputPath(process.cwd(), "tmp");
  await mkdir(directory, { recursive: true });
  return mkdtemp(join(directory, prefix));
}

async function initGitRoot(root) {
  await execFileAsync("git", ["init", "-q", root]);
}

async function makeReadyProject() {
  const fixture = await makeContractsFixture({ root: await makeSessionTemp("wrapper-ready-") });
  await mkdir(join(fixture.root, "docs/agents"), { recursive: true });
  await writeFile(join(fixture.root, "docs/agents/EXEC.md"), "Project execution instructions.\n");
  await writeFile(join(fixture.root, "docs/agents/execution.json"), JSON.stringify({ schema_version: 1, profiles: {
    test: { command: ["node", "-e", "process.exit(0)"], required_env: [], config_inputs: ["src/implementation.mjs", "tests/implementation.test.mjs"], prepare: [], verify_config: [["node", "-e", "process.exit(0)"]], dependencies: [], timeout_ms: 1000, readiness_timeout_ms: 100, poll_interval_ms: 10 },
  } }));
  const root = fixture.root;
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "src/implementation.mjs"), "export const implemented = true;\n");
  await writeFile(join(root, "tests/implementation.test.mjs"), "assert.equal(true, true);\n");
  const spec = "docs/specs/496";
  const base = "docs/plans/496";
  const ids = ["plan-a", "plan-b", "plan-contracts"];
  await mkdir(join(root, spec), { recursive: true });
  await mkdir(join(root, base), { recursive: true });
  const requirements = ids.map((id, index) => ({
    id: `BR-${index + 1}`, source_path: `${spec}/product-spec.md`, source_anchor: `BR-${index + 1}`,
    statement: `Requirement for ${id}.`, owner: id, plan_ids: [id], disposition: "covered",
  }));
  await writeFile(join(root, `${spec}/product-spec.md`), `# Product\n${requirements.map(({ id, statement }) => `- **${id}:** ${statement}`).join("\n")}\n`);
  await writeFile(join(root, `${spec}/architecture-spec.md`), "# Architecture\nNo additional declared IDs.\n");
  const plans = ids.map((id, index) => ({
    id, requirement_ids: [`${spec}/product-spec.md#BR-${index + 1}`], content_path: `${base}/${id}.md`, verification_profile: "test",
    acceptance_criteria: [`Acceptance for ${id}.`], counterexamples: [`Counterexample for ${id}.`], verification_cases: [`Verification for ${id}.`],
  }));
  await writeFile(join(root, `${base}/plans.md`), `# Plans\n${ids.join("\n")}\n`);
  for (const plan of plans) await writeFile(join(root, plan.content_path), `${plan.id} BR-${plan.requirement_ids[0].split("#").at(-1).split("-").at(-1)}\n${plan.acceptance_criteria[0]}\n${plan.counterexamples[0]}\n${plan.verification_cases[0]}\n`);
  const ledgerPath = join(root, base, "traceability.json");
  const ledger = { schema_version: 1, plan_set_id: "496", ticket_id: "496", spec_paths: [`${spec}/product-spec.md`, `${spec}/architecture-spec.md`], requirements, plans };
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  ledger.review = { reviewer_id: "independent-reviewer", author_ids: ["plan-author"], fork_turns: "none", verdict: "pass", findings: [], inputs: (await snapshotPlanTraceability({ root, planSetId: "496" })).inputs };
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  assert.equal((await sealContracts({ workspace_root: root, change_summary: "Traceability dispatch fixture", no_contract_change: "Add temporary plan/spec fixture inputs" })).status, "pass");
  await execFileAsync("git", ["add", "docs/agents", "docs/specs", "docs/plans", "docs/contracts", "src/implementation.mjs", "tests/implementation.test.mjs"], { cwd: root });
  await execFileAsync("git", ["commit", "-qm", "traceability test plans"], { cwd: root });
  return fixture;
}

async function recordImplementationEvidence(root, planId) {
  const { stdout } = await execFileAsync(process.execPath, [new URL("../.codex/scripts/harness-exec.mjs", import.meta.url).pathname, "--root", root, "--profile", "test"], { cwd: root, encoding: "utf8", env: process.env });
  const execution = JSON.parse(stdout);
  const ledgerPath = join(root, "docs/plans/496/traceability.json");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const plan = ledger.plans.find((item) => item.id === planId);
  const requirementId = plan.requirement_ids[0];
  const evidence = async (path) => ({ path, sha256: createHash("sha256").update(await readFile(join(root, path))).digest("hex") });
  ledger.implementation = {
    ...(ledger.implementation || {}),
    [planId]: { requirements: [{ requirement_id: requirementId, files: [await evidence("src/implementation.mjs")], verification: [await evidence("tests/implementation.test.mjs")], receipt: execution.evidence_path.replace(`${sessionDirectory(root)}/`, "") }] },
  };
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
  assert.equal((await sealContracts({ workspace_root: root, change_summary: "Record implementation evidence", no_contract_change: "Add execution evidence to the plan ledger" })).status, "pass");
}

test("sequential dispatch requires the caller's explicit execution line", async () => {
  const root = await makeSessionTemp("wrapper-execution-line-required-");
  try {
    await initGitRoot(root);
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    await assert.rejects(() => dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
      slotRegistry: new ExecutionSlotRegistry(),
      spawnImplement: async () => { throw new Error("must not dispatch"); },
      checkpointStore: store,
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      model: "test-model",
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
    }), (error) => error.reason === "execution_line_required");
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch tracker gate blocks before spawning when a managed mirror is incomplete", async () => {
  const root = await makeSessionTemp("wrapper-tracker-gate-");
  const bin = join(root, "bin");
  await initGitRoot(root);
  await mkdir(join(root, ".beads"));
  await mkdir(bin);
  await writeFile(join(bin, "bd"), "#!/bin/sh\nprintf '%s\\n' '[{\"id\":\"bd-1\",\"metadata\":{\"harness_tracker_version\":1}}]'\n", "utf8");
  await chmod(join(bin, "bd"), 0o755);
  try {
    const dispatchUrl = new URL("../src/wrapper/dispatch.mjs", import.meta.url).href;
    const checkpointUrl = new URL("../src/wrapper/checkpoint.mjs", import.meta.url).href;
    const schedulerUrl = new URL("../src/wrapper/scheduler.mjs", import.meta.url).href;
    const script = `import assert from 'node:assert/strict'; import { dispatchImplementPlan } from ${JSON.stringify(dispatchUrl)}; import { PlanCheckpointStore } from ${JSON.stringify(checkpointUrl)}; import { ExecutionSlotRegistry } from ${JSON.stringify(schedulerUrl)}; const root=process.env.TRACKER_TEST_ROOT; const store=new PlanCheckpointStore({root,planId:'plan-a'}); let spawned=false; try { await assert.rejects(()=>dispatchImplementPlan({plan:{id:'plan-a'},plans:[{id:'plan-a',status:'planned',dependencies:[],resources:['filesystem:src/a']}],planSetId:'496',repository:root,executionLine:root,slotRegistry:new ExecutionSlotRegistry(),spawnImplement:async()=>{spawned=true},checkpointStore:store,smartZone:{phase:'dispatch',state:'fits',evidence:'dispatch fits'},model:'test-model',readGitState:async()=>({changed_files:[]}),readTestState:async()=>({status:'not-run'})}),e=>e.reason==='workspace_preflight_failed'); assert.equal(spawned,false); } finally { await store.close(); }`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, TRACKER_TEST_ROOT: root } });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dispatch blocks missing project readiness even when caller claims it passed", async () => {
  const root = await makeSessionTemp("wrapper-readiness-gate-");
  try {
    await initGitRoot(root);
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    let spawned = false;
    await assert.rejects(() => dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
      executionLine: root,
      slotRegistry: new ExecutionSlotRegistry(),
      spawnImplement: async () => { spawned = true; },
      checkpointStore: store,
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      model: "test-model",
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
    }), (error) => {
      assert.equal(error.reason, "workspace_preflight_failed");
      assert.equal(error.workspace_preflight.checks.find((check) => check.rule_id === "project_readiness").reason, "project_preparation_required");
      return true;
    });
    assert.equal(spawned, false);
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implement dispatch always creates a fresh context and resumes the same plan", async () => {
  const fixture = await makeReadyProject();
  const root = fixture.root;
  try {
    const executionLine = root;
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    const calls = [];
    const spawnImplement = async (input) => {
      const child = { context_id: `context-${calls.length + 1}` };
      calls.push({ ...input, ...child });
      return child;
    };
    const first = await dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: executionLine,
      executionLine,
      slotRegistry: slots,
      spawnImplement,
      checkpointStore: store,
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      model: "test-model",
      readGitState: async () => ({ changed_files: [], last_completed_step: "baseline" }),
      readTestState: async () => ({ status: "not-run" }),
    });
    slots.release(first.slot);
    const second = await dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "in-progress", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: executionLine,
      executionLine,
      slotRegistry: slots,
      spawnImplement,
      checkpointStore: store,
      smartZone: { phase: "after-action", state: "fits", evidence: "resume fits" },
      model: "test-model",
      readGitState: async () => ({ changed_files: [], last_completed_step: "resume baseline" }),
      readTestState: async () => ({ status: "not-run" }),
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].fresh_context, true);
    assert.equal(calls[0].empty_context, true);
    const session = sessionDirectory(executionLine);
    const temp = sessionOutputPath(executionLine, "tmp");
    assert.equal(calls[0].session_directory, session);
    assert.equal(calls[0].env.HARNESS_SESSION_DIR, session);
    for (const key of ["TMPDIR", "TMP", "TEMP"]) assert.equal(calls[0].env[key], temp);
    assert.equal(calls[0].workspace_root, executionLine);
    assert.equal(calls[0].cwd, executionLine);
    assert.ok(calls[0].prompt.includes("workspace_mode: sequential"));
    assert.ok(calls[0].prompt.includes(`workspace_reference: ${join(executionLine, ".codex/internal-skills/session-worktree/references/sequential.md")}`));
    assert.equal(calls[0].prompt.includes("references/parallel.md"), false);
    assert.notEqual(calls[0].context_id, calls[1].context_id);
    assert.equal(first.attempt, 1);
    assert.equal(second.attempt, 2);
    slots.release(second.slot);
  } finally {
    await fixture.cleanup();
  }
});

test("Smart Zone handoff persists before dispatching a fresh implement context", async () => {
  const fixture = await makeReadyProject();
  const root = fixture.root;
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    let spawned = false;
    const result = await dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
      executionLine: root,
      slotRegistry: slots,
      spawnImplement: async () => { spawned = true; },
      checkpointStore: store,
      smartZone: { phase: "before-next-action", state: "handoff-required", evidence: "not enough context" },
      model: "test-model",
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
    });
    assert.equal(result.dispatched, true);
    assert.equal(spawned, true);
    assert.equal(result.attempt, 2);
    assert.equal((await store.read()).handoff_reason, "context-threshold");
    slots.release(result.slot);
    await store.close();
  } finally {
    await fixture.cleanup();
  }
});

test("parallel implement dispatch allocates and verifies its fixed-base worktree", async () => {
  const root = await makeSessionTemp("wrapper-managed-worktree-");
  const fixture = await makeReadyProject();
  const repository = fixture.root;
  try {
    const fixedGroupBase = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    const manager = new WorktreeManager({ repoRoot: repository, runtimeRoot: sessionOutputPath(repository, "runtime/dispatch-test") });
    const result = await dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [
        { id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] },
        { id: "plan-b", status: "planned", dependencies: [], resources: ["filesystem:src/b"] },
      ],
      planSetId: "496",
      repository,
      slotRegistry: slots,
      spawnImplement: async (input) => ({ context_id: "managed-worktree", workspace: input.workspace, cwd: input.cwd, workspace_root: input.workspace_root }),
      checkpointStore: store,
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      model: "test-model",
      fixedGroupBase,
      runId: "run-dispatch",
      worktreeManager: manager,
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
    });
    assert.equal(result.workspace_allocated, true);
    assert.equal(result.workspace.mode, "parallel");
    assert.equal(result.workspace.baseSha, fixedGroupBase);
    assert.equal(result.workspace.groupId, "parallel-run-dispatch-wave-0-group-0-6_plan-a_6_plan-b");
    assert.equal(result.workspace_root, result.workspace.workspace);
    assert.equal(result.child.workspace_root, result.workspace.workspace);
    assert.equal(result.child.cwd, result.workspace.workspace);
    assert.ok(result.prompt.includes("workspace_mode: parallel"));
    assert.ok(result.prompt.includes(`workspace_reference: ${join(result.workspace.workspace, ".codex/internal-skills/session-worktree/references/parallel.md")}`));
    assert.equal(result.prompt.includes("references/sequential.md"), false);
    assert.ok(result.prompt.includes(`Active workspace root: ${result.workspace.workspace}`));
    assert.equal((await manager.verify(result.workspace)).valid, true);
    slots.release(result.slot);
    assert.equal((await manager.cleanup(result.workspace, { evidencePersisted: true })).cleanup.state, "passed");
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("Standards and Spec reviewers run in independent fresh contexts", async () => {
  const calls = [];
  const reports = await runIndependentReviewers({
    plan: { id: "plan-a" },
    implementation: { commit_sha: "abc123" },
    fixedPoint: "base-1",
    planSetId: "496",
    repository: "/workspace/repo",
    commitList: ["base-1", "abc123"],
    diff: "diff --git a/src/a b/src/a",
    config: { agents: { implementation_model: "review-model" } },
    spawnReviewer: async (input) => {
      calls.push(input);
      return { state: "passed", role: input.agent_type, implementation_commit_sha: input.implementation.commit_sha, independent: true, fresh_context: true, context_id: `${input.agent_type}-context` };
    },
  });
  assert.deepEqual(reports.map(({ role }) => role), ["standards", "spec"]);
  assert.deepEqual(reports.map(({ implementation_commit_sha }) => implementation_commit_sha), ["abc123", "abc123"]);
  assert.deepEqual(calls.map(({ agent_type, fresh_context, empty_context }) => ({ agent_type, fresh_context, empty_context })), [
    { agent_type: "standards_reviewer", fresh_context: true, empty_context: true },
    { agent_type: "spec_reviewer", fresh_context: true, empty_context: true },
  ]);
  assert.equal(calls[0].fixed_point, "base-1");
  assert.deepEqual(calls[0].diff_range, { from: "base-1", to: "abc123" });
  assert.equal(calls[0].product_spec_path, "docs/specs/496/product-spec.md");
  assert.equal(calls[0].architecture_spec_path, "docs/specs/496/architecture-spec.md");
  assert.deepEqual(calls.map(({ model }) => model), ["review-model", "review-model"]);
});

test("implementation lifecycle blocks completion and dependents when contracts are missing", async () => {
  const fixture = await makeReadyProject();
  const root = fixture.root;
  try {
    await writeFile(join(root, "README.md"), "Retirement test fixture.\n");
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    let runCount = 0;
    const run = () => executeImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
      executionLine: root,
      checkpointStore: store,
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "passed", command: "npm test" }),
      slotRegistry: new ExecutionSlotRegistry(),
      model: "test-model",
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      spawnImplement: async () => ({ context_id: "implement-1" }),
      captureFixedPoint: async () => "base-1",
      waitForImplementation: async () => {
        if (++runCount === 2) await unlink(join(root, "docs/contracts/manifest.json"));
        return { state: "completed", workspace_root: root, commit_sha: "implementation-1", commit_list: ["base-1", "implementation-1"], diff: "diff --git a/src/a b/src/a" };
      },
      config: { agents: { implementation_model: "implementation-model" } },
      spawnReviewer: async ({ agent_type }) => ({
        state: "passed",
        independent: true,
        fresh_context: true,
        context_id: `${agent_type}-1`,
        implementation_commit_sha: "implementation-1",
      }),
      pr: { merged: false },
      trackerSnapshot: { status: "Done", project_status: "Done", all_issues_closed: false },
      dependents: [{ id: "plan-b", status: "planned", dependencies: ["plan-a"] }],
      retirement: { removed_paths: ["README.md"] },
    });
    const unresolved = await run();
    assert.equal(unresolved.completion.state, "in-progress");
    assert.equal(unresolved.completion.unresolved.includes("retirement:retired_path_still_present"), true);
    assert.equal(unresolved.reviews.length, 2);
    assert.equal(unresolved.completion.tracker_reconciliation.requested_status, "In Progress");
    assert.deepEqual(unresolved.completion.dependents.ready, []);
    assert.deepEqual(unresolved.completion.dependents.waiting[0].reasons, ["dependency:plan-a"]);

    await unlink(join(root, "README.md"));
    const result = await run();
    assert.equal(result.fixed_point, "base-1");
    assert.equal(result.completion.state, "in-progress");
    assert.ok(result.completion.unresolved.includes("contract_docs:contracts_invalid"));
    assert.equal(result.completion.tracker_reconciliation.requested_status, "In Progress");
    assert.deepEqual(result.completion.dependents.ready, []);
    assert.deepEqual(result.completion.dependents.waiting[0].reasons, ["dependency:plan-a"]);
    const checkpoint = await store.read();
    assert.equal(checkpoint.last_completed_step, "completion gate unresolved");
    assert.equal(checkpoint.lifecycle_evidence.completion.state, "in-progress");
    await store.close();
  } finally {
    await fixture.cleanup();
  }
});

test("implementation lifecycle completes with sealed canonical contracts", async () => {
  const { root, cleanup } = await makeReadyProject();
  try {
    await recordImplementationEvidence(root, "plan-contracts");
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const base = stdout.trim();
    const store = new PlanCheckpointStore({ root, planId: "plan-contracts" });
    const result = await executeImplementPlan({
      plan: { id: "plan-contracts" }, plans: [{ id: "plan-contracts", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496", repository: root, executionLine: root, checkpointStore: store,
      readGitState: async () => ({ changed_files: [] }), readTestState: async () => ({ status: "passed", command: "npm test" }),
      slotRegistry: new ExecutionSlotRegistry(), model: "test-model", smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      spawnImplement: async () => ({ context_id: "implement-contracts" }), captureFixedPoint: async () => base,
      waitForImplementation: async () => ({ state: "completed", workspace_root: root, commit_sha: "implementation-contracts", commit_list: [base, "implementation-contracts"], diff: "diff --git a/src/a b/src/a" }),
      config: { agents: { implementation_model: "implementation-model" } },
      spawnReviewer: async ({ agent_type }) => ({ state: "passed", independent: true, fresh_context: true, context_id: `${agent_type}-contracts`, implementation_commit_sha: "implementation-contracts" }),
      pr: { merged: false }, trackerSnapshot: { status: "Done", project_status: "Done", all_issues_closed: false },
    });
    assert.equal(result.completion.state, "completed");
    assert.equal(result.completion.tracker_reconciliation.requested_status, "Done");
    assert.equal((await store.read()).lifecycle_evidence.contract_docs.status, "pass");
    await store.close();
  } finally { await cleanup(); }
});

test("implementation lifecycle blocks a result reported from a different workspace", async () => {
  const fixture = await makeReadyProject();
  const root = fixture.root;
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    await assert.rejects(() => executeImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
      executionLine: root,
      checkpointStore: store,
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
      slotRegistry: new ExecutionSlotRegistry(),
      model: "test-model",
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      spawnImplement: async () => ({ context_id: "implement-wrong-root" }),
      captureFixedPoint: async () => "base-1",
      waitForImplementation: async () => ({ state: "completed", workspace_root: join(root, "elsewhere"), commit_sha: "implementation-1" }),
      config: { agents: { implementation_model: "implementation-model" } },
      spawnReviewer: async () => { throw new Error("review must not run after workspace mismatch"); },
    }), (error) => error.reason === "workspace_mismatch");
    await store.close();
  } finally {
    await fixture.cleanup();
  }
});

test("implementation profile is optional and accepts configured or explicit values", () => {
  assert.deepEqual(resolveImplementationProfile(), { model: null, reasoning_effort: null });
  assert.deepEqual(resolveImplementationProfile({ config: { agents: { implementation_model: "configured-model", implementation_reasoning_effort: "high" } } }), { model: "configured-model", reasoning_effort: "high" });
  assert.deepEqual(resolveImplementationProfile({ model: "configured-model", reasoningEffort: "medium" }), { model: "configured-model", reasoning_effort: "medium" });
  assert.deepEqual(resolveImplementationProfile({ config: { agents: { implementation_model: "configured-model", implementation_reasoning_effort: "high" } }, reasoningEffort: "medium" }), { model: "configured-model", reasoning_effort: "medium" });
});

test("reviewer model binding resolves configured model and fails without setup", () => {
  assert.deepEqual(resolveReviewerProfile({ config: { agents: { implementation_model: "configured-review-model" } } }), { model: "configured-review-model" });
  assert.deepEqual(resolveReviewerProfile({ config: { agents: { low_performance_model: "legacy-review-model" } } }), { model: "legacy-review-model" });
  assert.deepEqual(resolveReviewerProfile({ profile: { model: "explicit-review-model" }, config: { agents: { implementation_model: "configured-review-model" } } }), { model: "explicit-review-model" });
  assert.deepEqual(resolveReviewerProfile(), { model: null });
});

test("loaded harness configuration exposes agent model bindings to dispatch", async () => {
  const { loadHarnessConfig } = await import("../src/eval/case-loader.mjs");
  const config = await loadHarnessConfig(process.cwd());
  assert.equal(config.agents.low_performance_model, "gpt-6-luna");
  assert.equal(config.agents.implementation_model, "gpt-6-luna");
  assert.deepEqual(resolveReviewerProfile({ config }), { model: "gpt-6-luna" });
});

test("explicit implementation model can override configured default", () => {
  assert.deepEqual(resolveImplementationProfile({
    config: { agents: { implementation_model: "configured-model", implementation_reasoning_effort: "high" } },
    model: "override-model",
    reasoningEffort: "low",
  }), { model: "override-model", reasoning_effort: "low" });
});

test("both reviewer outcomes are collected when one reviewer rejects", async () => {
  const completed = [];
  const reports = await runIndependentReviewers({
    plan: { id: "plan-a" },
    implementation: { commit_sha: "abc123" },
    fixedPoint: "base-1",
    planSetId: "496",
    repository: "/workspace/repo",
    commitList: ["base-1", "abc123"],
    diff: "diff --git a/src/a b/src/a",
    config: { agents: { implementation_model: "review-model" } },
    spawnReviewer: async ({ agent_type }) => {
      await new Promise((resolve) => setTimeout(resolve, agent_type === "standards_reviewer" ? 5 : 15));
      completed.push(agent_type);
      if (agent_type === "standards_reviewer") throw new Error("standards unavailable");
      return { state: "passed", independent: true, fresh_context: true, context_id: "spec-context", implementation_commit_sha: "abc123" };
    },
  });
  assert.deepEqual(completed.sort(), ["spec_reviewer", "standards_reviewer"]);
  assert.equal(reports.find(({ role }) => role === "standards").state, "error");
  assert.equal(reports.find(({ role }) => role === "spec").state, "passed");
});

test("parallel dispatch requires the allocated fixed-base worktree", async () => {
  const root = await makeSessionTemp("wrapper-parallel-dispatch-");
  try {
    await initGitRoot(root);
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    const options = {
      plan: { id: "plan-a" },
      plans: [
        { id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] },
        { id: "plan-b", status: "planned", dependencies: [], resources: ["filesystem:src/b"] },
      ],
      planSetId: "496",
      repository: root,
      executionLine: root,
      slotRegistry: slots,
      spawnImplement: async () => ({ context_id: "parallel-a" }),
      checkpointStore: store,
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      model: "test-model",
      fixedGroupBase: "base-1",
      runId: "run-preallocated",
      workspaceVerifier: async () => ({ valid: true }),
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
    };
    await assert.rejects(() => dispatchImplementPlan(options), (error) => error.reason === "workspace_isolation_required");
    await assert.rejects(() => dispatchImplementPlan({
      ...options,
      workspaceGroupId: "parallel-wrong-group",
      workspace: { mode: "parallel", owned: true, workspace: join(root, "worktree-a"), baseSha: "base-1", fixedGroupBase: "base-1", groupId: "parallel-run-preallocated-wave-0-group-0-6_plan-a_6_plan-b" },
    }), (error) => error.reason === "workspace_group_mismatch");
    await assert.rejects(() => dispatchImplementPlan({
      ...options,
      workspace: { mode: "parallel", owned: true, workspace: join(root, "worktree-a"), baseSha: "base-1", fixedGroupBase: "base-1", groupId: "parallel-run-preallocated-wave-0-group-0-6_plan-a_6_plan-b" },
    }), (error) => error.reason === "workspace_preflight_failed");
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("review input rejects an empty diff and cross-ticket spec path", async () => {
  const input = {
    plan: { id: "plan-a" },
    implementation: { commit_sha: "abc123" },
    fixedPoint: "base-1",
    planSetId: "496",
    repository: "/workspace/repo",
    commitList: ["base-1", "abc123"],
    spawnReviewer: async () => ({ state: "passed" }),
  };
  await assert.rejects(() => runIndependentReviewers({ ...input, diff: "   " }), /non-empty string/);
  await assert.rejects(() => runIndependentReviewers({ ...input, diff: "diff", productSpecPath: "docs/specs/487/product-spec.md" }), /productSpecPath must be docs\/specs\/496\/product-spec\.md/);
});

test("dispatch failure leaves a retry blocker in the event-sourced checkpoint", async () => {
  const fixture = await makeReadyProject();
  const root = fixture.root;
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    await assert.rejects(() => dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
      executionLine: root,
      slotRegistry: slots,
      spawnImplement: async () => { throw new Error("spawn unavailable"); },
      checkpointStore: store,
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      model: "test-model",
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
    }), /spawn unavailable/);
    const checkpoint = await store.read();
    assert.equal(checkpoint.blocker.kind, "dispatch");
    assert.equal(checkpoint.handoff_reason, "retry");
    assert.deepEqual(slots.activePlanIds(), []);
    await store.close();
  } finally {
    await fixture.cleanup();
  }
});

test("duplicate dispatch is recorded as a retry blocker instead of stale running state", async () => {
  const fixture = await makeReadyProject();
  const root = fixture.root;
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    const options = {
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "in-progress", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
      executionLine: root,
      slotRegistry: slots,
      spawnImplement: async () => ({ context_id: "context-1" }),
      checkpointStore: store,
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      model: "test-model",
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
    };
    const first = await dispatchImplementPlan(options);
    await assert.rejects(() => dispatchImplementPlan(options), /already has an active execution slot/);
    assert.equal((await store.read()).blocker.kind, "dispatch");
    slots.release(first.slot);
    await store.close();
  } finally {
    await fixture.cleanup();
  }
});
