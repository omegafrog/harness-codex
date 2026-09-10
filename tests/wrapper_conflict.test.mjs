import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlanCheckpointStore } from "../src/wrapper/checkpoint.mjs";
import { ConflictRouter, detectPlanConflicts } from "../src/wrapper/conflict.mjs";
import { ExecutionSlotRegistry } from "../src/wrapper/scheduler.mjs";

test("conflict router pauses affected slots and requires one explicit priority route", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-conflict-"));
  try {
    const stores = new Map();
    const storeFor = (planId) => {
      if (!stores.has(planId)) stores.set(planId, new PlanCheckpointStore({ root, planId }));
      return stores.get(planId);
    };
    const conflicts = detectPlanConflicts([
      { plan_id: "a", resources: ["src/shared"] },
      { plan_id: "b", resources: ["src/shared/schema"] },
    ]);
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0].shared_resources, [{ left: "filesystem:src/shared", right: "filesystem:src/shared/schema" }]);
    let stopped = 0;
    const slots = new ExecutionSlotRegistry({ stopSlot: async () => { stopped += 1; } });
    slots.acquire("a");
    const dispatches = [];
    const recalculations = [];
    const router = new ConflictRouter({ checkpointStoreFor: storeFor, slotRegistry: slots, dispatchPlan: async (input) => { dispatches.push(input); return { context_id: `context-${dispatches.length}`, slot: slots.acquire(input.plan_id) }; }, recalculateReady: async (input) => { recalculations.push(input); return ["a", "b"]; } });
    await router.pause(conflicts[0]);
    assert.equal(stopped, 1);
    assert.equal(slots.activePlanIds().length, 1);
    assert.equal((await storeFor("a").read()).orchestration_state, "conflict-paused");
    await assert.rejects(() => router.resume("a"), /explicit priority decision/);
    const route = await router.routePriority({ affectedPlanIds: ["a", "b"], selectedPlanId: "a" });
    assert.deepEqual(route.resume_order, ["a", "b"]);
    assert.equal((await storeFor("b").read()).orchestration_state, "priority-routed");
    await assert.rejects(() => router.routePriority({ affectedPlanIds: ["a", "c"], selectedPlanId: "a" }), /No matching conflict/);
    const resumedA = await router.resume("a");
    assert.deepEqual({ plan_id: resumedA.plan_id, state: resumedA.state, next_plan_id: resumedA.next_plan_id, context_id: resumedA.dispatch.context_id }, { plan_id: "a", state: "running", next_plan_id: "b", context_id: "context-1" });
    assert.equal(resumedA.dispatch.slot.plan_id, "a");
    assert.equal(dispatches[0].fresh_context, true);
    assert.deepEqual(recalculations[0], { completedPlanIds: [] });
    slots.release(resumedA.dispatch.slot);
    await assert.rejects(() => router.resume("b"), /before a completes/);
    const resumedB = await router.resume("b", { completedPlanIds: ["a"] });
    assert.deepEqual({ plan_id: resumedB.plan_id, state: resumedB.state, next_plan_id: resumedB.next_plan_id, context_id: resumedB.dispatch.context_id }, { plan_id: "b", state: "running", next_plan_id: null, context_id: "context-2" });
    slots.release(resumedB.dispatch.slot);
    assert.deepEqual(recalculations[1], { completedPlanIds: ["a"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conflict detection groups a shared-resource component into one affected set", () => {
  const conflicts = detectPlanConflicts([
    { plan_id: "a", resources: ["filesystem:shared"] },
    { plan_id: "b", resources: ["filesystem:shared/schema"] },
    { plan_id: "c", resources: ["filesystem:shared/schema/types"] },
  ]);
  assert.deepEqual(conflicts.map(({ plan_ids }) => plan_ids), [["a", "b", "c"]]);
  assert.equal(conflicts[0].shared_resources.length, 3);
});

test("unknown resources are reported as uncertainty, not false overlap evidence", () => {
  const conflicts = detectPlanConflicts([
    { plan_id: "a", resources: null },
    { plan_id: "b", resources: ["filesystem:src"] },
  ]);
  assert.equal(conflicts[0].kind, "resource_independence_unknown");
  assert.deepEqual(conflicts[0].shared_resources, []);
});

test("partial slot-stop failure records grouped evidence and blocks priority routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-conflict-partial-"));
  try {
    const stores = new Map();
    const storeFor = (planId) => {
      if (!stores.has(planId)) stores.set(planId, new PlanCheckpointStore({ root, planId }));
      return stores.get(planId);
    };
    const slots = new ExecutionSlotRegistry();
    slots.acquire("a", { onPause: async () => { throw new Error("stop failed"); } });
    slots.acquire("b", { onPause: async () => {} });
    const router = new ConflictRouter({
      checkpointStoreFor: storeFor,
      slotRegistry: slots,
      dispatchPlan: async () => ({ context_id: "never" }),
      recalculateReady: async () => [],
    });
    const conflict = detectPlanConflicts([
      { plan_id: "a", resources: ["filesystem:shared"] },
      { plan_id: "b", resources: ["filesystem:shared"] },
    ])[0];
    await assert.rejects(() => router.pause(conflict), (error) => error.reason === "conflict_pause_failed");
    assert.equal((await storeFor("a").read()).blocker.kind, "conflict");
    assert.equal((await storeFor("b").read()).blocker.kind, "conflict");
    await assert.rejects(() => router.routePriority({ affectedPlanIds: ["a", "b"], selectedPlanId: "a" }), /did not pause every/);
    await storeFor("a").close();
    await storeFor("b").close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
