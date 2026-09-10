import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_HOOK_CHECKS,
  LifecycleGateRegistry,
  runLifecycleHook,
} from "../src/gates/index.mjs";

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
    evidencePath: "docs/plans/.runtime/plan-1/events.jsonl",
  });

  assert.equal(result.status, "pass");
  assert.equal(result.hook, "before_dispatch");
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
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.checks.find((check) => check.rule_id === "evidence_flush").status, "blocked");

  const failed = await runLifecycleHook({
    hook: "before_handoff",
    state: { checkpoint: { complete: false }, evidence_flush: { durable: false } },
  });
  assert.equal(failed.status, "fail");
  assert.deepEqual(failed.violations, ["checkpoint_completeness"]);
});

test("unknown hook and check fail closed as blocked verdicts", async () => {
  const unknownHook = await runLifecycleHook({ hook: "not-a-hook", state: {} });
  assert.equal(unknownHook.status, "blocked");
  assert.equal(unknownHook.reason, "unknown_hook");
  assert.equal(unknownHook.internal_event.type, "hook_execution_error");

  const registry = new LifecycleGateRegistry({ hooks: { custom: ["custom_check"] } });
  const unknownCheck = await runLifecycleHook({ hook: "custom", registry, state: {} });
  assert.equal(unknownCheck.status, "blocked");
  assert.equal(unknownCheck.reason, "unknown_check");
  assert.equal(unknownCheck.internal_event.type, "hook_execution_error");
});

test("registry supports explicit gate registration and replacement", async () => {
  const registry = new LifecycleGateRegistry({ hooks: { custom: ["custom_check"] } });
  registry.register("custom_check", () => ({ status: "pass", reason: "ok" }));
  assert.equal((await registry.run("custom", {})).status, "pass");

  registry.replace("custom_check", () => ({
    status: "fail",
    reason: "changed",
    violations: ["custom_check"],
  }));
  const result = await registry.run("custom", {});
  assert.equal(result.status, "fail");
  assert.deepEqual(result.violations, ["custom_check"]);
});

test("malformed validator output is recorded as an execution error and fails closed", async () => {
  const registry = new LifecycleGateRegistry({ hooks: { custom: ["broken"] } });
  registry.register("broken", () => ({ status: "pass" }));
  const result = await registry.run("custom", {});

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "hook_execution_error");
  assert.equal(result.internal_event.type, "hook_execution_error");
  assert.equal(result.internal_event.rule_id, "broken");
});
