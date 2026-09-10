import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlanCheckpointStore } from "../src/wrapper/checkpoint.mjs";
import { dispatchImplementPlan, runIndependentReviewers } from "../src/wrapper/dispatch.mjs";
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
      planSetId: "496",
      repository: root,
      slotRegistry: slots,
      spawnImplement,
      checkpointStore: store,
    });
    slots.release(first.slot);
    const second = await dispatchImplementPlan({
      plan: { id: "plan-a" },
      planSetId: "496",
      repository: root,
      slotRegistry: slots,
      spawnImplement,
      checkpointStore: store,
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

test("Smart Zone handoff persists without dispatching an implement context", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-dispatch-zone-"));
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    const slots = new ExecutionSlotRegistry();
    let spawned = false;
    const result = await dispatchImplementPlan({
      plan: { id: "plan-a" },
      planSetId: "496",
      repository: root,
      slotRegistry: slots,
      spawnImplement: async () => { spawned = true; },
      checkpointStore: store,
      smartZone: { phase: "before-next-action", state: "handoff-required", evidence: "not enough context" },
    });
    assert.equal(result.dispatched, false);
    assert.equal(spawned, false);
    assert.equal((await store.read()).handoff_reason, "context-threshold");
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
      return { state: "passed", role: input.agent_type };
    },
  });
  assert.deepEqual(reports.map(({ role }) => role), ["standards", "spec"]);
  assert.deepEqual(calls.map(({ agent_type, fresh_context, empty_context }) => ({ agent_type, fresh_context, empty_context })), [
    { agent_type: "standards_reviewer", fresh_context: true, empty_context: true },
    { agent_type: "spec_reviewer", fresh_context: true, empty_context: true },
  ]);
});
