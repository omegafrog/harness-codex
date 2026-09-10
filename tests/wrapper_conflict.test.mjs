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
    const router = new ConflictRouter({ checkpointStoreFor: storeFor, slotRegistry: slots });
    await router.pause(conflicts[0]);
    assert.equal(stopped, 1);
    assert.equal(slots.activePlanIds().length, 1);
    assert.equal((await storeFor("a").read()).orchestration_state, "conflict-paused");
    await assert.rejects(() => router.resume("a"), /explicit priority decision/);
    const route = await router.routePriority({ affectedPlanIds: ["a", "b"], selectedPlanId: "a" });
    assert.deepEqual(route.resume_order, ["a", "b"]);
    assert.equal((await storeFor("b").read()).orchestration_state, "priority-routed");
    assert.deepEqual(await router.resume("a"), { plan_id: "a", state: "running", next_plan_id: "b" });
    await assert.rejects(() => router.resume("b"), /before a completes/);
    assert.deepEqual(await router.resume("b", { completedPlanIds: ["a"] }), { plan_id: "b", state: "running", next_plan_id: null });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
