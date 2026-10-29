import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { relative, join } from "node:path";
import test from "node:test";

import { e2eLearningComplete } from "../src/eval/contracts.mjs";
import { PlanCheckpointStore } from "../src/wrapper/checkpoint.mjs";
import { evaluateCompletion } from "../src/wrapper/reconciliation.mjs";
import { sessionDirectory, sessionOutputPath } from "../src/workflow/session-output.mjs";

function makeFailure(root, fields = {}) {
  const path = (name) => relative(sessionDirectory(root), sessionOutputPath(root, name));
  return {
    id: "run-1",
    category: "product",
    status: "verified",
    scenario: "checkout",
    profile_id: "e2e-learning-check",
    evidence_path: path("evidence/failure.json"),
    cause: "stale state was accepted",
    lesson_path: path("lessons/checkout.md"),
    verification_path: path("verification/checkout.test.mjs"),
    prevention_paths: [path("src/checkout.mjs")],
    learning_route: "project_e2e_lesson",
    learning_target: path("lessons/checkout.md"),
    ...fields,
  };
}

test("E2E test results remain independent of learning while failure history is preserved", async () => {
  const root = await mkdtemp(sessionOutputPath(process.cwd(), "tmp/e2e-learning-"));
  const failure = makeFailure(root);
  const sessionTests = (e2e_failures) => ({ status: "passed", e2e_failures });
  try {
    assert.equal(e2eLearningComplete(sessionTests([{ ...failure, status: "open" }])), false);
    assert.equal(e2eLearningComplete(sessionTests([{ ...failure, category: "unknown" }])), false);
    assert.equal(e2eLearningComplete(sessionTests([{ ...failure, evidence_path: "/tmp/failure.json" }])), false);
    assert.equal(e2eLearningComplete(sessionTests([{ ...failure, prevention_paths: ["../checkout.mjs"] }])), false);
    assert.equal(e2eLearningComplete(sessionTests([failure, failure])), false);
    assert.equal(e2eLearningComplete(sessionTests([failure])), true);
    assert.equal(e2eLearningComplete({ status: "passed" }), true);
    assert.equal(e2eLearningComplete(sessionTests([{ id: "one-off", learning_route: "not_reusable", cause: "No reusable procedure" }])), true);

    const lifecycle = await import("../src/gates/lifecycle.mjs");
    const eventWriter = { append: async () => ({ seq: 1 }) };
    for (const e2e_failures of [[{ ...failure, status: "open" }], [{ ...failure, prevention_paths: [] }]]) {
      const result = await lifecycle.runLifecycleHook({ hook: "before_complete", state: { tests: sessionTests(e2e_failures) }, eventWriter });
      const check = result.checks.find((check) => check.rule_id === "tests");
      assert.equal(check.status, "pass");
      assert.equal(check.details.e2e_learning, "pending");
    }
    const failed = await lifecycle.runLifecycleHook({ hook: "before_complete", state: { tests: { status: "failed", e2e_failures: [failure] } }, eventWriter });
    assert.equal(failed.checks.find((check) => check.rule_id === "tests").status, "fail");
    const completed = await lifecycle.runLifecycleHook({ hook: "before_complete", state: { tests: sessionTests([failure]) }, eventWriter });
    assert.equal(completed.checks.find((check) => check.rule_id === "tests").status, "pass");

    const store = new PlanCheckpointStore({ root, planId: "e2e-learning" });
    try {
      await store.write({ tests: sessionTests([{ ...failure, status: "open" }]) });
      await store.write({ tests: { status: "passed" } });
      const replayed = await store.read();
      assert.deepEqual(replayed.tests.e2e_failures, [{ ...failure, status: "open" }]);
      await store.write({ tests: { status: "passed", e2e_failures: [] } });
      assert.deepEqual((await store.read()).tests.e2e_failures, [{ ...failure, status: "open" }]);
      await assert.rejects(() => store.write({ tests: null }), /requires an object/i);
      await assert.rejects(async () => store.write({ tests: sessionTests([{ ...failure, status: "verified", evidence_path: "evidence/replaced.json" }]) }), /cannot be replaced/i);
      await store.close();
      const resumed = new PlanCheckpointStore({ root, planId: "e2e-learning" });
      try {
        assert.deepEqual((await resumed.read()).tests.e2e_failures, [{ ...failure, status: "open" }]);
        await resumed.write({ tests: sessionTests([failure]) });
      const completion = (tests) => evaluateCompletion({
        planReview: { status: "pass" },
        contractDocs: { status: "pass" },
        implementation: { state: "completed", commit_sha: "abc" },
        tests,
        reviews: [
          { role: "spec", state: "passed", independent: true, fresh_context: true, context_id: "spec", implementation_commit_sha: "abc" },
          { role: "standards", state: "passed", independent: true, fresh_context: true, context_id: "standards", implementation_commit_sha: "abc" },
        ],
        evidence: {
          fixed_point: "base",
          implementation: { state: "completed", commit_sha: "abc" },
          tests,
          reviews: [{ role: "spec" }, { role: "standards" }],
          pr: { merged: false },
        },
        pr: { merged: false },
      });
      assert.equal(completion(sessionTests([{ ...failure, status: "open" }])).can_complete, true);
      assert.equal(completion(sessionTests([{ ...failure, status: "open" }])).evidence.e2e_learning, "pending");
      assert.equal(completion({ status: "failed", e2e_failures: [failure] }).can_complete, false);
        assert.equal(completion((await resumed.read()).tests).can_complete, true);
      } finally {
        await resumed.close();
      }
    } finally {
      await store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
