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
    reviews: [
      { role: "spec", state: "passed", independent: true, fresh_context: true, implementation_commit_sha: "abc123" },
      { role: "standards", state: "passed", independent: true, fresh_context: true, implementation_commit_sha: "abc123" },
    ],
    blocker: null,
    pr: { merged: true },
  });
  assert.equal(passed.can_complete, true);

  const unresolved = evaluateCompletion({
    implementation: { state: "completed", commit_sha: "abc123" },
    reviews: [
      { role: "spec", state: "requested_changes", independent: true, fresh_context: true, implementation_commit_sha: "abc123" },
      { role: "standards", state: "passed", independent: true, fresh_context: true, implementation_commit_sha: "abc123" },
    ],
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
    reviews: [
      { role: "spec", state: "passed", independent: true, fresh_context: true, implementation_commit_sha: "abc123" },
      { role: "standards", state: "passed", independent: true, fresh_context: true, implementation_commit_sha: "abc123" },
    ],
    pr: { merged: true },
    trackerSnapshot: { status: "Done", project_status: "Done", all_issues_closed: true },
  });
  assert.equal(report.state, "completed");
  assert.equal(report.tracker_reconciliation.current_status, "Done");
  assert.equal(report.tracker_reconciliation.requested_status, "Done");
  assert.equal(report.tracker_reconciliation.mutated, false);
});

test("local-markdown reconciliation uses local canonical statuses", () => {
  const report = reconcileCompletion({
    plan: { id: "local-plan", dependencies: [] },
    implementation: { state: "completed", commit_sha: "abc123" },
    reviews: [
      { role: "spec", state: "passed", independent: true, fresh_context: true, implementation_commit_sha: "abc123" },
      { role: "standards", state: "passed", independent: true, fresh_context: true, implementation_commit_sha: "abc123" },
    ],
    pr: { merged: true },
    trackerMode: "local-markdown",
    trackerSnapshot: { status: "completed" },
  });
  assert.equal(report.state, "completed");
  assert.equal(report.tracker_reconciliation.requested_status, "completed");
});
