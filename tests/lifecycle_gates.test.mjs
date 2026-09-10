import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HOOK_CHECKS,
  LifecycleGateRegistry,
  recordNativePermissionResult,
  runLifecycleHook,
} from "../src/gates/index.mjs";

function eventWriter() {
  return { append: async () => ({ seq: 1 }) };
}

test("lifecycle hook returns a deterministic pass verdict for all checks", async () => {
  const registry = new LifecycleGateRegistry();
  const result = await runLifecycleHook({
    hook: "before_dispatch",
    registry,
    state: {
      dependencies: { all_satisfied: true },
      resource_conflict: { present: false },
      workspace: { valid: true },
      permission_preflight: { passed: true },
    },
    eventWriter: eventWriter(),
    evidencePath: "docs/plans/.runtime/plan-1/events.jsonl",
  });

  assert.equal(result.status, "pass");
  assert.equal(result.hook, "before_dispatch");
  assert.equal(result.rule_id, "lifecycle.before_dispatch");
  assert.deepEqual(result.checks.map((check) => check.rule_id), DEFAULT_HOOK_CHECKS.before_dispatch);
  assert.equal(result.evidence_path, "docs/plans/.runtime/plan-1/events.jsonl");
  assert.deepEqual(result.violations, []);
  assert.equal("next_action" in result, false);
  assert.equal("retry" in result, false);
  assert.equal("route" in result, false);
});

test("lifecycle hook aggregates failures and blocked prerequisites without routing", async () => {
  const result = await runLifecycleHook({
    hook: "before_complete",
    state: {
      required_outcome: { passed: false },
      tests: { status: "passed" },
      reviews: { spec: { state: "passed" }, standards: { state: "pending" } },
      evidence: { complete: false },
    },
    eventWriter: eventWriter(),
  });

  assert.equal(result.status, "fail");
  assert.deepEqual(result.violations, [
    "required_outcome",
    "review",
    "evidence",
  ]);
  assert.equal(result.checks.find((check) => check.rule_id === "review").status, "fail");
  assert.equal(result.checks.find((check) => check.rule_id === "tests").status, "pass");
});

test("blocked checks take precedence over pass but not over an observed failure", async () => {
  const blocked = await runLifecycleHook({
    hook: "before_handoff",
    state: { checkpoint: { complete: true }, evidence_flush: { durable: false } },
    eventWriter: eventWriter(),
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.checks.find((check) => check.rule_id === "evidence_flush").status, "blocked");

  const failed = await runLifecycleHook({
    hook: "before_handoff",
    state: { checkpoint: { complete: false }, evidence_flush: { durable: false } },
    eventWriter: eventWriter(),
  });
  assert.equal(failed.status, "fail");
  assert.deepEqual(failed.violations, ["checkpoint_completeness"]);
});

test("unknown hook and check fail closed as blocked verdicts", async () => {
  const recorded = [];
  const eventWriter = {
    append: async (...args) => {
      recorded.push(args);
      return { seq: recorded.length };
    },
  };
  const unknownHook = await runLifecycleHook({ hook: "not-a-hook", state: {}, eventWriter });
  assert.equal(unknownHook.status, "blocked");
  assert.equal(unknownHook.reason, "unknown_hook");
  assert.equal(unknownHook.internal_event.type, "hook_execution_error");
  assert.equal(unknownHook.internal_event.recorded, true);

  const registry = new LifecycleGateRegistry();
  registry.registerHook("after_merge", ["missing_check"]);
  const unknownCheck = await runLifecycleHook({ hook: "after_merge", registry, state: {}, eventWriter });
  assert.equal(unknownCheck.status, "blocked");
  assert.equal(unknownCheck.reason, "unknown_check");
  assert.equal(unknownCheck.internal_event.type, "hook_execution_error");
  assert.equal(unknownCheck.internal_event.recorded, true);
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0][0], "hook_execution_error");
});

test("registry supports explicit gate registration and replacement", async () => {
  const registry = new LifecycleGateRegistry();
  registry.register("custom_check", () => ({ status: "pass", reason: "ok" }));
  registry.registerHook("after_merge", ["custom_check"]);
  assert.equal((await registry.run("after_merge", {}, { eventWriter: eventWriter() })).status, "pass");

  registry.replace("custom_check", () => ({
    status: "fail",
    reason: "changed",
    violations: ["custom_check"],
  }));
  const result = await registry.run("after_merge", {}, { eventWriter: eventWriter() });
  assert.equal(result.status, "fail");
  assert.deepEqual(result.violations, ["custom_check"]);
});

test("malformed validator output is recorded as an execution error and fails closed", async () => {
  const registry = new LifecycleGateRegistry();
  registry.registerHook("after_merge", ["broken"]);
  registry.register("broken", () => ({ status: "pass" }));
  const recorded = [];
  const result = await registry.run("after_merge", {}, {
    eventWriter: {
      append: async (...args) => {
        recorded.push(args);
        return { seq: 1 };
      },
    },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "hook_execution_error");
  assert.equal(result.internal_event.type, "hook_execution_error");
  assert.equal(result.internal_event.rule_id, "broken");
  assert.equal(result.internal_event.recorded, true);
  assert.equal(recorded[0][0], "hook_execution_error");
});

test("malformed verdict field types are recorded as execution errors", async () => {
  const registry = new LifecycleGateRegistry();
  registry.registerHook("after_merge", ["broken_types"]);
  registry.register("broken_types", () => ({
    status: "pass",
    reason: "bad shape",
    violations: [{}],
    evidence_path: {},
  }));
  const result = await registry.run("after_merge", {}, { eventWriter: eventWriter() });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "hook_execution_error");
  assert.equal(result.internal_event.rule_id, "broken_types");
});

test("non-Error validator throws still produce a blocked evidence verdict", async () => {
  const registry = new LifecycleGateRegistry();
  registry.registerHook("after_merge", ["throws_null"]);
  registry.register("throws_null", () => { throw null; });
  const recorded = [];
  const result = await registry.run("after_merge", {}, {
    eventWriter: { append: async (...args) => { recorded.push(args); return { seq: 1 }; } },
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "hook_execution_error");
  assert.equal(result.internal_event.message, "null");
  assert.equal(result.internal_event.recorded, true);
  assert.equal(recorded[0][0], "hook_execution_error");
});

test("non-string hook identifiers fail closed without error formatting failures", async () => {
  const result = await runLifecycleHook({
    hook: Symbol("bad-hook"),
    eventWriter: eventWriter(),
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "invalid_hook");
  assert.equal(result.hook, "Symbol(bad-hook)");
  assert.equal(result.internal_event.type, "hook_execution_error");
});

test("empty hooks and unrelated evidence fields fail closed", async () => {
  const registry = new LifecycleGateRegistry();
  registry.registerHook("after_merge", []);
  const empty = await registry.run("after_merge", {}, { eventWriter: eventWriter() });
  assert.equal(empty.status, "blocked");
  assert.equal(empty.reason, "empty_hook");

  const wrongField = await runLifecycleHook({
    hook: "after_merge",
    state: { tracker_reconciliation: { durable: true } },
    eventWriter: eventWriter(),
  });
  assert.equal(wrongField.status, "blocked");
  assert.equal(wrongField.reason, "tracker_reconciliation_evidence_missing");
});

test("only the four lifecycle hook names can be registered", () => {
  const registry = new LifecycleGateRegistry();
  assert.throws(() => registry.registerHook("custom", ["tests"]), /Unsupported lifecycle hook/);
  assert.throws(() => new LifecycleGateRegistry({ hooks: { custom: ["tests"] } }), /Unsupported lifecycle hook/);
});

test("native permission evidence is recorded through a separate event contract", async () => {
  const recorded = [];
  const result = await recordNativePermissionResult({
    result: { decision: "denied", action: "write", target: "src/secret.txt", evidence_path: "run/events.jsonl" },
    eventWriter: { append: async (...args) => { recorded.push(args); return { seq: 7 }; } },
  });

  assert.deepEqual(result, {
    decision: "denied",
    action: "write",
    target: "src/secret.txt",
    evidence_path: "run/events.jsonl",
    recorded: true,
    event_seq: 7,
  });
  assert.equal(recorded[0][0], "native_permission_denied");
  assert.equal("status" in result, false);
});
