#!/usr/bin/env node
import { DECISION_EVIDENCE_GATE_ID, DECISION_REVIEW_GATE_ID, evaluateDecisionEvidenceComplete, evaluateDecisionReviewComplete, evaluateSystemTargetsComplete, SYSTEM_TARGET_GATE_ID } from "../../src/workflow/stage-gates.mjs";

function parseArgs(args) {
  if (args.length !== 3 || ![SYSTEM_TARGET_GATE_ID, DECISION_EVIDENCE_GATE_ID, DECISION_REVIEW_GATE_ID].includes(args[0]) || args[1] !== "--ticket" || !args[2]) {
    throw new TypeError(`Usage: node .codex/scripts/harness-decision-gate.mjs <${[SYSTEM_TARGET_GATE_ID, DECISION_EVIDENCE_GATE_ID, DECISION_REVIEW_GATE_ID].join("|")}> --ticket <ticket-id>`);
  }
  return { gateId: args[0], ticketId: args[2] };
}

try {
  const { gateId, ticketId } = parseArgs(process.argv.slice(2));
  const evaluator = new Map([
    [SYSTEM_TARGET_GATE_ID, evaluateSystemTargetsComplete],
    [DECISION_EVIDENCE_GATE_ID, evaluateDecisionEvidenceComplete],
    [DECISION_REVIEW_GATE_ID, evaluateDecisionReviewComplete],
  ]).get(gateId);
  const result = await evaluator({ root: process.cwd(), ticketId });
  if (result.rule_id !== gateId) throw new TypeError(`Unsupported decision gate: ${gateId}`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "pass" ? 0 : result.status === "blocked" ? 2 : 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 64;
}
