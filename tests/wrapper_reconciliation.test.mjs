import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateCompletion,
  recalculateDependents,
  reconcileCompletion,
} from "../src/wrapper/reconciliation.mjs";

test("completion stays unresolved for review or blocker and recalculates dependents", () => {
  const passed = evaluateCompletion({
    implementation: { state: "completed", commit_sha: "abc123" },
    reviews: [{ role: "spec", state: "passed" }, { role: "standards", state: "passed" }],
    blocker: null,
    pr: { merged: true },
  });
  assert.equal(passed.can_complete, true);

  const unresolved = evaluateCompletion({
    implementation: { state: "completed", commit_sha: "abc123" },
    reviews: [{ role: "spec", state: "requested_changes" }, { role: "standards", state: "passed" }],
    blocker: null,
    pr: { merged: false },
  });
  assert.equal(unresolved.can_complete, false);
  assert.deepEqual(unresolved.unresolved, ["review:spec", "pr:not-merged"]);

  const dependents = recalculateDependents([
    { id: "a", status: "done", dependencies: [] },
    { id: "b", status: "planned", dependencies: ["a"] },
    { id: "c", status: "planned", dependencies: ["a", "missing"] },
  ], { completedPlanIds: ["a"] });
  assert.deepEqual(dependents, { ready: ["b"], waiting: [{ plan_id: "c", reasons: ["dependency:missing"] }] });

  const report = reconcileCompletion({
    plan: { id: "a", dependencies: [] },
    implementation: { state: "completed", commit_sha: "abc123" },
    reviews: [{ role: "spec", state: "passed" }, { role: "standards", state: "passed" }],
    pr: { merged: true },
    trackerSnapshot: { status: "In Progress" },
  });
  assert.equal(report.state, "completed");
  assert.equal(report.tracker_reconciliation.current_status, "In Progress");
  assert.equal(report.tracker_reconciliation.requested_status, "Done");
  assert.equal(report.tracker_reconciliation.mutated, false);
});
