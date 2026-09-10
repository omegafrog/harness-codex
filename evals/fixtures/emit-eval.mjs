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

function emitAction(action, target, payload = {}) {
  console.log(JSON.stringify({ kind: "tool_call", actor: "codex", action, target, payload }));
  console.log(JSON.stringify({ kind: "tool_result", actor: "codex", action, target, status: "success", payload }));
}

if (caseId?.startsWith("spec-me") && workspace) {
  const target = ".eval-output/specs/496/product-spec.md";
  await mkdir(join(workspace, ".eval-output/specs/496"), { recursive: true });
  await writeFile(join(workspace, target), "# Evaluated Product Spec\n", "utf8");
  emitAction("write_file", target, { path: target });
  emitAction("resolve_ambiguity", undefined, { decision: "confirmed" });
} else if (caseId === "implement-wrapper-dependency") {
  emitAction("dispatch_plan", "plan-1", { plan_id: "plan-1" });
  emitAction("dependency_check", "plan-1", { satisfied: true });
} else if (caseId === "code-review-isolation") {
  emitAction("reviewer_spawn", "reviewers", { context_ids: ["spec-1", "standards-1"] });
  emitAction("review_verdict", "implementation", { verdicts: ["pass", "pass"] });
}
