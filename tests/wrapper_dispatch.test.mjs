import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlanCheckpointStore } from "../src/wrapper/checkpoint.mjs";
import { dispatchImplementPlan, executeImplementPlan, resolveImplementationProfile, runIndependentReviewers } from "../src/wrapper/dispatch.mjs";
import { ExecutionSlotRegistry } from "../src/wrapper/scheduler.mjs";

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

test("Standards and Spec reviewers run in independent fresh contexts", async () => {
  const calls = [];
  const reports = await runIndependentReviewers({
    plan: { id: "plan-a" },
    implementation: { commit_sha: "abc123" },
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
      readTestState: async () => ({ status: "not-run" }),
      slotRegistry: new ExecutionSlotRegistry(),
      model: "test-model",
      smartZone: { phase: "dispatch", state: "fits", evidence: "dispatch fits" },
      spawnImplement: async () => ({ context_id: "implement-1" }),
      captureFixedPoint: async () => "base-1",
      waitForImplementation: async () => ({ state: "completed", commit_sha: "implementation-1" }),
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
