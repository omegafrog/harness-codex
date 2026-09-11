import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { WorktreeManager } from "../src/eval/plan-workspace.mjs";
import { PlanCheckpointStore } from "../src/wrapper/checkpoint.mjs";
import { dispatchImplementPlan, executeImplementPlan, resolveImplementationProfile, runIndependentReviewers } from "../src/wrapper/dispatch.mjs";
import { ExecutionSlotRegistry } from "../src/wrapper/scheduler.mjs";

const execFileAsync = promisify(execFile);

test("implement dispatch always creates a fresh context and resumes the same plan", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-dispatch-"));
  try {
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
      repository: root,
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
      repository: root,
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
    assert.notEqual(calls[0].context_id, calls[1].context_id);
    assert.equal(first.attempt, 1);
    assert.equal(second.attempt, 2);
    slots.release(second.slot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Smart Zone handoff persists before dispatching a fresh implement context", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-dispatch-zone-"));
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    let spawned = false;
    const result = await dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
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
    await rm(root, { recursive: true, force: true });
  }
});

test("parallel implement dispatch allocates and verifies its fixed-base worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-managed-worktree-"));
  const repository = process.cwd();
  try {
    const fixedGroupBase = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim();
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    const manager = new WorktreeManager({ repoRoot: repository, runtimeRoot: join(root, "worktrees") });
    const result = await dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [
        { id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] },
        { id: "plan-b", status: "planned", dependencies: [], resources: ["filesystem:src/b"] },
      ],
      planSetId: "496",
      repository,
      slotRegistry: slots,
      spawnImplement: async (input) => ({ context_id: "managed-worktree", workspace: input.workspace }),
      checkpointStore: store,
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      model: "test-model",
      fixedGroupBase,
      worktreeManager: manager,
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
    });
    assert.equal(result.workspace_allocated, true);
    assert.equal(result.workspace.mode, "parallel");
    assert.equal(result.workspace.baseSha, fixedGroupBase);
    assert.equal((await manager.verify(result.workspace)).valid, true);
    slots.release(result.slot);
    assert.equal((await manager.cleanup(result.workspace, { evidencePersisted: true })).cleanup.state, "passed");
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
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
});

test("implementation lifecycle cannot complete without reviewer provenance for the same commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-lifecycle-"));
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const result = await executeImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
      checkpointStore: store,
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "passed", command: "npm test" }),
      slotRegistry: new ExecutionSlotRegistry(),
      model: "test-model",
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      spawnImplement: async () => ({ context_id: "implement-1" }),
      captureFixedPoint: async () => "base-1",
      waitForImplementation: async () => ({ state: "completed", commit_sha: "implementation-1", commit_list: ["base-1", "implementation-1"], diff: "diff --git a/src/a b/src/a" }),
      spawnReviewer: async ({ agent_type }) => ({
        state: "passed",
        independent: true,
        fresh_context: true,
        context_id: `${agent_type}-1`,
        implementation_commit_sha: "implementation-1",
      }),
      pr: { merged: true },
      trackerSnapshot: { status: "Done", project_status: "Done", all_issues_closed: true },
    });
    assert.equal(result.fixed_point, "base-1");
    assert.equal(result.completion.state, "completed");
    assert.equal(result.reviews.length, 2);
    const checkpoint = await store.read();
    assert.equal(checkpoint.last_completed_step, "completion gate passed");
    assert.equal(checkpoint.lifecycle_evidence.completion.state, "completed");
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("implementation profile must be resolved from config or an explicit model", () => {
  assert.deepEqual(resolveImplementationProfile({ config: { agents: { implementation_model: "configured-model", implementation_reasoning_effort: "high" } } }), { model: "configured-model", reasoning_effort: "high" });
  assert.throws(() => resolveImplementationProfile(), /implementation_model/);
  assert.throws(() => resolveImplementationProfile({ model: "configured-model", reasoningEffort: "medium" }), /high reasoning/);
  assert.throws(() => resolveImplementationProfile({ config: { agents: { implementation_model: "configured-model", implementation_reasoning_effort: "medium" } }, reasoningEffort: "high" }), /high reasoning/);
});

test("configured implementation model cannot be bypassed by a call-site override", () => {
  assert.deepEqual(resolveImplementationProfile({
    config: { agents: { implementation_model: "configured-model", implementation_reasoning_effort: "high" } },
    model: "override-model",
  }), { model: "configured-model", reasoning_effort: "high" });
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
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-parallel-dispatch-"));
  try {
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
      slotRegistry: slots,
      spawnImplement: async () => ({ context_id: "parallel-a" }),
      checkpointStore: store,
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      model: "test-model",
      fixedGroupBase: "base-1",
      workspaceVerifier: async () => ({ valid: true }),
      readGitState: async () => ({ changed_files: [] }),
      readTestState: async () => ({ status: "not-run" }),
    };
    await assert.rejects(() => dispatchImplementPlan(options), (error) => error.reason === "workspace_isolation_required");
    const result = await dispatchImplementPlan({
      ...options,
      workspace: { mode: "parallel", owned: true, workspace: join(root, "worktree-a"), baseSha: "base-1", fixedGroupBase: "base-1" },
    });
    assert.equal(result.slot.workspace.workspace, join(root, "worktree-a"));
    slots.release(result.slot);
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
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-dispatch-failure-"));
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    await assert.rejects(() => dispatchImplementPlan({
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
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
    await rm(root, { recursive: true, force: true });
  }
});

test("duplicate dispatch is recorded as a retry blocker instead of stale running state", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-duplicate-dispatch-"));
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    const options = {
      plan: { id: "plan-a" },
      plans: [{ id: "plan-a", status: "in-progress", dependencies: [], resources: ["filesystem:src/a"] }],
      planSetId: "496",
      repository: root,
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
    await rm(root, { recursive: true, force: true });
  }
});
