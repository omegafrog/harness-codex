import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyReviewFindings,
  planRepairRound,
  runBoundedReviewRepair,
} from "../src/wrapper/repair.mjs";

test("review findings classify only bounded implementation repairs as repairable", () => {
  const result = classifyReviewFindings([
    { role: "standards", state: "failed", report: { findings: [
      { id: "impl-1", kind: "implementation_defect", summary: "Null handling is incorrect." },
      { id: "test-1", kind: "test_defect", summary: "Missing regression assertion." },
    ] } },
  ]);

  assert.equal(result.repairable.length, 2);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.repairable.map(({ kind }) => kind), ["implementation_defect", "test_defect"]);
});

test("ambiguity, architecture, scope, and spec conflicts are immediate blockers", () => {
  const result = classifyReviewFindings([
    { role: "spec", state: "failed", report: { findings: [
      { kind: "requirement_ambiguity", summary: "The requirement has two interpretations." },
      { kind: "architecture_decision", summary: "A new boundary is required." },
      { kind: "scope_expansion", summary: "The repair needs another package." },
      { kind: "spec_conflict", summary: "The two specs disagree." },
    ] } },
  ]);

  assert.equal(result.repairable.length, 0);
  assert.deepEqual(result.blockers.map(({ kind }) => kind), [
    "requirement_ambiguity",
    "architecture_decision",
    "scope_expansion",
    "spec_conflict",
  ]);
  assert.equal(planRepairRound({ reviews: [{ role: "spec", state: "failed", report: { findings: [{ kind: "requirement_ambiguity", summary: "Ambiguous." }] } }] }).action, "block");
});

test("bounded repair dispatches one fresh repair and fresh reviewer round", async () => {
  const calls = [];
  const result = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [{ role: "standards", state: "failed", report: { findings: [{ kind: "implementation_defect", id: "impl-1", summary: "Fix it." }] } }],
    maxRounds: 1,
    dispatchRepair: async (input) => {
      calls.push({ type: "repair", input });
      return { plan_id: "plan-a", commit_sha: "impl-2", fresh_context: true, empty_context: true, context_id: "repair-context" };
    },
    runReviewers: async (input) => {
      calls.push({ type: "review", input });
      return [
        { role: "standards", state: "passed", independent: true, fresh_context: true, context_id: "standards-2", implementation_commit_sha: "impl-2" },
        { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec-2", implementation_commit_sha: "impl-2" },
      ];
    },
  });

  assert.equal(result.state, "passed");
  assert.equal(result.rounds, 1);
  assert.equal(result.implementation.commit_sha, "impl-2");
  assert.deepEqual(calls.map(({ type }) => type), ["repair", "review"]);
  assert.equal(calls[0].input.fresh_context, true);
  assert.equal(calls[0].input.empty_context, true);
  assert.equal(calls[1].input.fresh_context, true);
  assert.equal(calls[1].input.empty_context, true);
});

test("bounded repair stops after max rounds and never repairs a blocker", async () => {
  let dispatches = 0;
  const result = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [{ role: "standards", state: "failed", report: { findings: [{ kind: "implementation_defect", summary: "Fix it." }] } }],
    maxRounds: 0,
    dispatchRepair: async () => { dispatches += 1; return null; },
    runReviewers: async () => [],
  });

  assert.equal(result.state, "blocked");
  assert.equal(result.reason, "max_repair_rounds_exceeded");
  assert.equal(dispatches, 0);

  const blocker = await runBoundedReviewRepair({
    plan: { id: "plan-a" },
    initialImplementation: { plan_id: "plan-a", commit_sha: "impl-1" },
    initialReviews: [{ role: "spec", state: "failed", report: { findings: [{ kind: "scope_expansion", summary: "Out of scope." }] } }],
    dispatchRepair: async () => { dispatches += 1; return null; },
    runReviewers: async () => [],
  });
  assert.equal(blocker.state, "blocked");
  assert.equal(blocker.reason, "scope_expansion");
  assert.equal(dispatches, 0);
});
