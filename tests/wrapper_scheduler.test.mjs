import assert from "node:assert/strict";
import test from "node:test";

import {
  ExecutionSlotRegistry,
  buildImplementPrompt,
  scheduleApprovedPlans,
} from "../src/wrapper/scheduler.mjs";

test("scheduler returns dependency-safe runnable groups and one-slot ids", () => {
  const result = scheduleApprovedPlans([
    { id: "a", status: "planned", dependencies: [], resources: ["filesystem:src/a"] },
    { id: "b", status: "planned", dependencies: [], resources: ["filesystem:src/b"] },
    { id: "c", status: "planned", dependencies: ["a"], resources: ["filesystem:src/c"] },
  ], { fixedGroupBase: "abc123" });

  assert.deepEqual(result.ready_plans, ["a", "b"]);
  assert.deepEqual(result.waiting_plans, [{ plan_id: "c", reasons: ["dependency:a"] }]);
  assert.deepEqual(result.parallel_groups, [{
    type: "parallel",
    plan_ids: ["a", "b"],
    fixed_group_base: "abc123",
    workspace: "isolated_worktree",
  }]);
  assert.deepEqual(result.single_slot_plan_ids, ["a", "b"]);
});

test("scheduler accepts canonical GitHub status names", () => {
  const result = scheduleApprovedPlans([
    { id: "planned", status: "Planned", dependencies: [], resources: ["filesystem:a"] },
    { id: "active", status: "In Progress", dependencies: [], resources: ["filesystem:b"] },
    { id: "done", status: "Done", dependencies: [], resources: ["filesystem:c"] },
  ], { fixedGroupBase: "abc123" });
  assert.deepEqual(result.ready_plans, ["planned", "active"]);
  assert.deepEqual(result.single_slot_plan_ids, ["planned", "active"]);
});

test("scheduler serializes unknown or conflicting resources and ignores split as parallelism", () => {
  const result = scheduleApprovedPlans([
    { id: "a", status: "planned", split: true, dependencies: [], resources: ["filesystem:src"] },
    { id: "b", status: "planned", split: true, dependencies: [], resources: ["filesystem:src/lib"] },
  ], { fixedGroupBase: "abc123" });

  assert.equal(result.parallel_groups[0].type, "sequential");
  assert.equal(result.parallel_groups[0].reason, "shared_resource_conflict");
  assert.deepEqual(result.single_slot_plan_ids, ["a", "b"]);
});

test("scheduler keeps an independent plan in a parallel batch beside a conflicting pair", () => {
  const result = scheduleApprovedPlans([
    { id: "a", status: "planned", dependencies: [], resources: ["src/shared"] },
    { id: "b", status: "planned", dependencies: [], resources: ["src/shared/schema"] },
    { id: "c", status: "planned", dependencies: [], resources: ["src/independent"] },
  ], { fixedGroupBase: "abc123" });
  assert.deepEqual(result.parallel_groups, [
    { type: "parallel", plan_ids: ["a", "c"], fixed_group_base: "abc123", workspace: "isolated_worktree" },
    { type: "sequential", plan_ids: ["b"], workspace: "execution_line", reason: "shared_resource_conflict" },
  ]);
});

test("execution slot registry rejects concurrent dispatch of the same plan", () => {
  const slots = new ExecutionSlotRegistry();
  const first = slots.acquire("plan-a", { attempt: 1 });
  assert.equal(first.plan_id, "plan-a");
  assert.throws(() => slots.acquire("plan-a", { attempt: 2 }), /already has an active execution slot/);
  assert.deepEqual(slots.activePlanIds(), ["plan-a"]);
  slots.release(first.slot_id);
  assert.deepEqual(slots.activePlanIds(), []);
});

test("implement prompt delegates one exact plan without wrapper semantics", () => {
  const prompt = buildImplementPrompt({
    repository: "/workspace/repo",
    planSetId: "496",
    planId: "497",
    dependencyFacts: { completed: [], waiting: [] },
    resourceFacts: { resources: ["filesystem:src/eval"] },
    smartZone: "fits",
  });

  assert.match(prompt, /exactly one plan: 497/);
  assert.match(prompt, /docs\/plans\/496\/plans\.md/);
  assert.match(prompt, /\.codex\/skills\/implement\/SKILL\.md/);
  assert.match(prompt, /Do not implement checkpoint, conflict, or reconciliation/);
});
