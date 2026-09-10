#!/usr/bin/env node
const outcomes = {
  "spec-me-source-policy": ["spec_complete", "ambiguity_resolved"],
  "spec-me-ambiguity-gate": ["spec_complete", "ambiguity_resolved"],
  "implement-wrapper-dependency": ["plan_dispatched", "dependency_satisfied"],
  "code-review-isolation": ["review_verdict_preserved", "reviewer_isolated"],
};
const caseId = process.env.HARNESS_EVAL_CASE_ID;
for (const outcome of outcomes[caseId] || []) {
  console.log(JSON.stringify({ kind: "message", actor: "codex", payload: { text: `[OUTCOME:${outcome}]` } }));
  console.log(JSON.stringify({ kind: "process_event", actor: "harness", action: outcome, payload: { outcome } }));
}
