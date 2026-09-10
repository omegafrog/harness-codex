import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PlanCheckpointStore,
  assessSmartZone,
  reconcileCheckpoint,
  reconcileCheckpointFromSources,
} from "../src/wrapper/checkpoint.mjs";

test("checkpoint store writes and reads the durable handoff contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-checkpoint-"));
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    await store.write({
      orchestration_state: "handoff-required",
      attempt: 2,
      last_completed_step: "focused verification",
      changed_files: ["src/a.js"],
      tests: { command: "npm test", passed: true },
      blocker: null,
      next_action: "start a fresh implement slot",
      handoff_reason: "context-threshold",
    });

    const checkpoint = await store.read();
    assert.equal(checkpoint.plan_id, "plan-a");
    assert.equal(checkpoint.attempt, 2);
    assert.deepEqual(checkpoint.changed_files, ["src/a.js"]);
    assert.equal(checkpoint.orchestration_state, "handoff-required");
    assert.match(await readFile(store.paths.checkpoint_path, "utf8"), /handoff_reason:/);
    const events = (await readFile(store.paths.events_path, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(events[0].type, "checkpoint_updated");
    assert.equal(events[0].payload.plan_id, "plan-a");
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint projection uses the latest valid event payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-wrapper-projection-"));
  try {
    const store = new PlanCheckpointStore({ root, planId: "plan-a" });
    await store.projectFromEvents([
      { schema_version: 1, stream_id: "plan-plan-a", seq: 1, type: "checkpoint_updated", payload: { orchestration_state: "running", last_completed_step: "old" } },
      { schema_version: 1, stream_id: "plan-plan-a", seq: 2, type: "checkpoint_updated", payload: { orchestration_state: "handoff-required", last_completed_step: "new", handoff_reason: "milestone" } },
    ]);
    const checkpoint = await store.read();
    assert.equal(checkpoint.last_completed_step, "new");
    assert.equal(checkpoint.orchestration_state, "handoff-required");
    assert.equal(checkpoint.handoff_reason, "milestone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("checkpoint reconciliation gives actual git and test state precedence", () => {
  const checkpoint = {
    plan_id: "plan-a",
    orchestration_state: "running",
    last_completed_step: "old step",
    changed_files: ["old.js"],
    tests: { passed: false },
  };
  const reconciled = reconcileCheckpoint(checkpoint, {
    last_completed_step: "actual test",
    changed_files: ["actual.js"],
    tests: { passed: true },
  });
  assert.equal(reconciled.last_completed_step, "actual test");
  assert.deepEqual(reconciled.changed_files, ["actual.js"]);
  assert.deepEqual(reconciled.tests, { passed: true });
});

test("checkpoint reconciliation can collect actual git and test state before projection", async () => {
  const reconciled = await reconcileCheckpointFromSources({
    plan_id: "plan-a",
    changed_files: ["stale.js"],
    tests: { passed: false },
  }, {
    readGitState: async () => ({ changed_files: ["actual.js"], last_completed_step: "git verified" }),
    readTestState: async () => ({ passed: true, command: "npm test" }),
  });
  assert.deepEqual(reconciled.changed_files, ["actual.js"]);
  assert.deepEqual(reconciled.tests, { passed: true, command: "npm test" });
});

test("smart zone reports handoff before the next bounded action crosses the threshold", () => {
  assert.deepEqual(assessSmartZone({ remaining: 100, required: 80, threshold: 10 }), { phase: "before-next-action", state: "fits", evidence: "100 remaining >= 90 required" });
  assert.deepEqual(assessSmartZone({ remaining: 89, required: 80, threshold: 10, phase: "after-action" }), { phase: "after-action", state: "handoff-required", evidence: "89 remaining < 90 required" });
});

test("dispatch rejects missing or invalid Smart Zone assessment", async () => {
  const { dispatchImplementPlan } = await import("../src/wrapper/dispatch.mjs");
  const { ExecutionSlotRegistry } = await import("../src/wrapper/scheduler.mjs");
  await assert.rejects(() => dispatchImplementPlan({
    plan: { id: "plan-a" },
    planSetId: "496",
    repository: "/repo",
    slotRegistry: new ExecutionSlotRegistry(),
    spawnImplement: async () => ({}),
  }), /valid Smart Zone assessment/);
  await assert.rejects(() => dispatchImplementPlan({
    plan: { id: "plan-a" },
    planSetId: "496",
    repository: "/repo",
    slotRegistry: new ExecutionSlotRegistry(),
    spawnImplement: async () => ({}),
    smartZone: { phase: "dispatch", state: "invalid", evidence: "bad" },
  }), /valid Smart Zone assessment/);
});
