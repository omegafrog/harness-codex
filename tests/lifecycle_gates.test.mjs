import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { sessionOutputPath } from "../src/workflow/session-output.mjs";

import {
  DEFAULT_HOOK_CHECKS,
  LifecycleGateRegistry,
  recordNativePermissionResult,
  runLifecycleHook,
} from "../src/gates/index.mjs";

function eventWriter() {
  return { append: async () => ({ seq: 1 }) };
}
const execFileAsync = promisify(execFile);
async function gitRoot() {
  const root = await mkdtemp(join(tmpdir(), "harness-lifecycle-git-"));
  await execFileAsync("git", ["init", "-q", root]);
  return root;
}

test("lifecycle hook returns a deterministic pass verdict for all checks", async () => {
  const root = await gitRoot();
  try {
  const registry = new LifecycleGateRegistry();
  const result = await runLifecycleHook({
    hook: "before_dispatch",
    registry,
    state: {
      workspace_root: root,
      dependencies: { all_satisfied: true },
      resource_conflict: { present: false },
      workspace: { valid: true, workspace_root: "/repo", cwd: "/repo", git_root: "/repo", worktree_registered: true },
      permission_preflight: { passed: true },
    },
    eventWriter: eventWriter(),
    evidencePath: sessionOutputPath(root, "plan-1/events.jsonl"),
  });

  assert.equal(result.status, "pass");
  assert.equal(result.hook, "before_dispatch");
  assert.equal(result.rule_id, "lifecycle.before_dispatch");
  assert.deepEqual(result.checks.map((check) => check.rule_id), DEFAULT_HOOK_CHECKS.before_dispatch);
  assert.equal(result.evidence_path, sessionOutputPath(root, "plan-1/events.jsonl"));
  assert.deepEqual(result.violations, []);
  assert.equal("next_action" in result, false);
  assert.equal("retry" in result, false);
  assert.equal("route" in result, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lifecycle hook aggregates failures and blocked prerequisites without routing", async () => {
  const root = await gitRoot();
  try {
  const result = await runLifecycleHook({
    hook: "before_complete",
    state: {
      workspace_root: root,
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
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("tracker_sync runs at both dispatch and completion boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-tracker-hook-"));
  const bin = join(root, "bin");
  await mkdir(join(root, ".beads"), { recursive: true });
  await mkdir(bin);
  await writeFile(join(bin, "bd"), "#!/bin/sh\nprintf '%s\\n' '[{\"id\":\"bd-1\",\"metadata\":{\"harness_tracker_version\":1}}]'\n", "utf8");
  await chmod(join(bin, "bd"), 0o755);
  try {
    const moduleUrl = new URL("../src/gates/lifecycle.mjs", import.meta.url).href;
    const script = `import assert from 'node:assert/strict'; import { runLifecycleHook } from ${JSON.stringify(moduleUrl)}; const writer={append:async()=>({seq:1})}; for (const hook of ['before_dispatch','before_complete']) { const result=await runLifecycleHook({hook,state:{workspace_root:process.env.TRACKER_TEST_ROOT},eventWriter:writer}); const check=result.checks.find(x=>x.rule_id==='tracker_sync'); assert.equal(check.status,'fail',hook); assert.match(check.violations.join(' '),/external_ref/); }`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH || ""}`, TRACKER_TEST_ROOT: root } });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("before_complete requires canonical contract documents", async () => {
  const root = await gitRoot();
  try {
  const result = await runLifecycleHook({ hook: "before_complete", state: { workspace_root: root }, eventWriter: eventWriter() });
  assert.equal(result.status, "blocked");
  assert.equal(result.checks.find((check) => check.rule_id === "contract_docs").reason, "contract_starting_commit_missing");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retirement gate verifies actual path removal and rejects missing or escaping contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-retirement-"));
  const registry = new LifecycleGateRegistry({ hooks: { ...DEFAULT_HOOK_CHECKS, before_complete: ["retirement"] } });
  const run = (retirement) => registry.run("before_complete", { retirement }, { eventWriter: eventWriter() });
  try {
    assert.equal((await run(undefined)).status, "blocked");
    assert.equal((await run({ workspace_root: root, removed_paths: [] })).status, "blocked");
    assert.equal((await run({ workspace_root: root, removed_paths: [], reason: "no replaced path" })).status, "pass");
    const contract = { workspace_root: root, removed_paths: ["legacy.mjs"] };
    await writeFile(join(root, "legacy.mjs"), "export {};\n");
    assert.equal((await run(contract)).checks[0].reason, "retired_path_still_present");
    await rm(join(root, "legacy.mjs"));
    assert.equal((await run(contract)).status, "pass");
    assert.equal((await run({ ...contract, removed_paths: ["../outside.mjs"] })).status, "fail");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plans_index lifecycle check fails when missing and passes for a non-empty index", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-plans-index-"));
  try {
    const registry = new LifecycleGateRegistry({
      hooks: { ...DEFAULT_HOOK_CHECKS, before_complete: ["plans_index"] },
    });
    const state = { plans_index: { workspace_root: root, plan_set_id: "496" } };
    const missing = await registry.run("before_complete", state, { eventWriter: eventWriter() });
    assert.equal(missing.status, "fail");
    assert.deepEqual(missing.violations, ["plans_index"]);

    const directory = join(root, "docs", "plans", "496");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "plans.md"), "# 계획 인덱스\n", "utf8");
    const present = await registry.run("before_complete", state, { eventWriter: eventWriter() });
    assert.equal(present.status, "pass");
    assert.equal(present.checks[0].reason, "plans_index_present");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plans_index lifecycle check blocks without valid path evidence", async () => {
  const registry = new LifecycleGateRegistry({
    hooks: { ...DEFAULT_HOOK_CHECKS, before_complete: ["plans_index"] },
  });
  const result = await registry.run("before_complete", { plans_index: { workspace_root: "/repo", plan_set_id: "../escape" } }, { eventWriter: eventWriter() });
  assert.equal(result.status, "blocked");
  assert.equal(result.checks[0].reason, "plans_index_evidence_incomplete");
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
  assert.equal(unknownHook.internal_event.rule_id, "lifecycle.not-a-hook");
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

test("empty hooks pass explicitly and unrelated evidence fields fail closed", async () => {
  const registry = new LifecycleGateRegistry();
  registry.registerHook("after_merge", []);
  const empty = await registry.run("after_merge", {}, { eventWriter: eventWriter() });
  assert.equal(empty.status, "pass");
  assert.equal(empty.reason, "no_checks_configured");

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

test("evidence persistence failure escapes as an explicit inconclusive boundary", async () => {
  await assert.rejects(
    () => runLifecycleHook({
      hook: "not-a-hook",
      eventWriter: { append: async () => { throw null; } },
    }),
    (error) => error.name === "HookEvidencePersistenceError"
      && error.reason === "hook_execution_error_persistence_failed"
      && error.event.rule_id === "lifecycle.not-a-hook"
      && error.event.recorded === false,
  );
});
