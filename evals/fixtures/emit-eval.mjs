#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  emitAction("resolve_ambiguity", ".eval-output/specs/496/ambiguity-resolved.json", { decision: "confirmed" });
} else if (caseId === "implement-wrapper-dependency") {
  await mkdir(join(workspace, ".eval-output/implementation"), { recursive: true });
  await writeFile(join(workspace, ".eval-output/implementation/plan-dispatched.json"), "{\"plan_id\":\"plan-1\"}\n", "utf8");
  await writeFile(join(workspace, ".eval-output/implementation/dependency-satisfied.json"), "{\"satisfied\":true}\n", "utf8");
  emitAction("write_file", ".eval-output/implementation/plan-dispatched.json", { plan_id: "plan-1" });
  emitAction("write_file", ".eval-output/implementation/dependency-satisfied.json", { satisfied: true });
} else if (caseId === "code-review-isolation") {
  await mkdir(join(workspace, ".eval-output/review"), { recursive: true });
  await writeFile(join(workspace, ".eval-output/review/contexts.json"), "{\"status\":\"blocked\",\"reason\":\"isolated_subagent_spawning_unavailable\",\"reviewers_started\":[]}\n", "utf8");
  emitAction("write_file", ".eval-output/review/contexts.json", { reason: "isolated_subagent_spawning_unavailable", reviewers_started: [] });
}

console.log(JSON.stringify({
  kind: "tool_call",
  actor: "codex",
  correlation_id: `external-call-${++callSequence}`,
  action: "external_request",
  target: { repo: "fixture/repo", issue: 1 },
  payload: { request: { system: "github", operation: "read_issue", target: { repo: "fixture/repo", issue: 1 }, payload: {} } },
}));
