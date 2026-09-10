import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_CONTEXT_POLICY,
  resolveContextPolicy,
  selectContextPolicy,
} from "../src/wrapper/context-policy.mjs";

test("context policy has explicit continuity and isolation defaults", () => {
  const policy = resolveContextPolicy();

  assert.equal(policy.reviewer, "isolated");
  assert.equal(policy.researcher, "isolated");
  assert.equal(policy.new_split_plan, "fresh");
  assert.equal(policy.same_split_plan, "continue");
  assert.equal(policy.smart_zone_exceeded, "checkpoint-and-fresh");
  assert.equal(policy.fork, "experimental");
  assert.equal(policy.compact, "experimental");
  assert.deepEqual(policy, DEFAULT_CONTEXT_POLICY);
});

test("context policy maps reviewer, plan, handoff, and experimental decisions", () => {
  assert.deepEqual(selectContextPolicy({ actor: "reviewer" }), { mode: "isolated", fresh_context: true, empty_context: true, checkpoint: false, reason: "reviewer-isolated" });
  assert.deepEqual(selectContextPolicy({ actor: "researcher" }), { mode: "isolated", fresh_context: true, empty_context: true, checkpoint: false, reason: "researcher-isolated" });
  assert.deepEqual(selectContextPolicy({ planTransition: "new_split_plan" }), { mode: "fresh", fresh_context: true, empty_context: true, checkpoint: false, reason: "new-split-plan" });
  assert.deepEqual(selectContextPolicy({ planTransition: "same_split_plan" }), { mode: "continue", fresh_context: false, empty_context: false, checkpoint: false, reason: "same-split-plan" });
  assert.deepEqual(selectContextPolicy({ smartZoneState: "handoff-required" }), { mode: "checkpoint-and-fresh", fresh_context: true, empty_context: true, checkpoint: true, reason: "smart-zone-exceeded" });
  assert.deepEqual(selectContextPolicy({ event: "fork" }).mode, "experimental");
  assert.deepEqual(selectContextPolicy({ event: "compact" }).mode, "experimental");
});

test("context policy rejects unknown or unsafe overrides", () => {
  assert.throws(() => resolveContextPolicy({ overrides: { unexpected: "fresh" } }), /unknown context policy/);
  assert.throws(() => resolveContextPolicy({ overrides: { reviewer: "continue" } }), /reviewer/);
});

test("role profile context policy is resolved and validated at the runtime boundary", () => {
  assert.equal(resolveContextPolicy({ profile: { context_policy: { reviewer: "isolated" } } }).reviewer, "isolated");
  assert.throws(() => resolveContextPolicy({ profile: { context_policy: { reviewer: "continue" } } }), /reviewer/);
});
