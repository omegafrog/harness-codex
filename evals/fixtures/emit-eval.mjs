#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const outcomes = {
  "spec-me-source-policy": ["spec_complete", "ambiguity_resolved"],
  "spec-me-ambiguity-gate": ["spec_complete", "ambiguity_resolved"],
  "implement-wrapper-dependency": ["plan_dispatched", "dependency_satisfied"],
  "code-review-isolation": ["review_verdict_preserved", "reviewer_isolated"],
};
const caseId = process.env.HARNESS_EVAL_CASE_ID;
const workspace = process.env.HARNESS_EVAL_WORKSPACE;

let callSequence = 0;
function emitAction(action, target, payload = {}) {
  const correlation_id = `call-${++callSequence}`;
  console.log(JSON.stringify({ kind: "tool_call", actor: "codex", correlation_id, action, target, payload }));
  console.log(JSON.stringify({ kind: "tool_result", actor: "codex", correlation_id, action, target, status: "success", payload }));
}

if (caseId?.startsWith("spec-me") && workspace) {
  const target = ".eval-output/specs/496/product-spec.md";
  await mkdir(join(workspace, ".eval-output/specs/496"), { recursive: true });
  await writeFile(join(workspace, target), "# Evaluated Product Spec\n", "utf8");
  await writeFile(join(workspace, ".eval-output/specs/496/ambiguity-resolved.json"), "{\"decision\":\"confirmed\"}\n", "utf8");
  emitAction("write_file", target, { path: target });
  emitAction("resolve_ambiguity", undefined, { decision: "confirmed" });
} else if (caseId === "implement-wrapper-dependency") {
  await mkdir(join(workspace, ".eval-output/implementation"), { recursive: true });
  await writeFile(join(workspace, ".eval-output/implementation/plan-dispatched.json"), "{\"plan_id\":\"plan-1\"}\n", "utf8");
  await writeFile(join(workspace, ".eval-output/implementation/dependency-satisfied.json"), "{\"satisfied\":true}\n", "utf8");
  emitAction("dispatch_plan", "plan-1", { plan_id: "plan-1" });
  emitAction("dependency_check", "plan-1", { satisfied: true });
} else if (caseId === "code-review-isolation") {
  await mkdir(join(workspace, ".eval-output/review"), { recursive: true });
  await writeFile(join(workspace, ".eval-output/review/contexts.json"), "{\"context_ids\":[\"spec-1\",\"standards-1\"]}\n", "utf8");
  await writeFile(join(workspace, ".eval-output/review/verdict.json"), "{\"verdicts\":[\"pass\",\"pass\"]}\n", "utf8");
  emitAction("reviewer_spawn", "reviewers", { context_ids: ["spec-1", "standards-1"] });
  emitAction("review_verdict", "implementation", { verdicts: ["pass", "pass"] });
}
