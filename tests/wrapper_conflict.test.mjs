import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PlanCheckpointStore } from "../src/wrapper/checkpoint.mjs";
import { ConflictRouter, detectPlanConflicts } from "../src/wrapper/conflict.mjs";

test("conflict router pauses affected slots and requires one explicit priority route", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-conflict-"));
  try {
    const stores = new Map();
    const storeFor = (planId) => {
      if (!stores.has(planId)) stores.set(planId, new PlanCheckpointStore({ root, planId }));
      return stores.get(planId);
    };
    const conflicts = detectPlanConflicts([
      { plan_id: "a", resources: ["filesystem:src/shared"] },
      { plan_id: "b", resources: ["filesystem:src/shared/schema"] },
    ]);
    assert.equal(conflicts.length, 1);
    const router = new ConflictRouter({ checkpointStoreFor: storeFor });
    await router.pause(conflicts[0]);
    assert.equal((await storeFor("a").read()).orchestration_state, "conflict-paused");
    await assert.rejects(() => router.resume("a"), /explicit priority decision/);
    const route = await router.routePriority({ affectedPlanIds: ["a", "b"], selectedPlanId: "a" });
    assert.deepEqual(route.resume_order, ["a", "b"]);
    assert.equal((await storeFor("b").read()).orchestration_state, "priority-routed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
