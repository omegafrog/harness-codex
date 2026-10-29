#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const installedRuntime = new URL("../harness-runtime/src/workflow/stage-gates.mjs", import.meta.url);
const sourceRuntime = new URL("../../src/workflow/stage-gates.mjs", import.meta.url);
const { DECISION_EVIDENCE_GATE_ID, DECISION_REVIEW_GATE_ID, evaluateDecisionEvidenceComplete, evaluateDecisionReviewComplete, evaluateSystemTargetsComplete, SYSTEM_TARGET_GATE_ID } = await import((existsSync(fileURLToPath(installedRuntime)) ? installedRuntime : sourceRuntime).href);
const installedDecision = new URL("../harness-runtime/src/decision/artifacts.mjs", import.meta.url);
const decisionRuntime = existsSync(fileURLToPath(installedDecision)) ? "../harness-runtime/src/decision/" : "../../src/decision/";
const { readArchitectureDecisionForHash } = await import(new URL(`${decisionRuntime}artifacts.mjs`, import.meta.url));
const { computeApprovalHash } = await import(new URL(`${decisionRuntime}approval.mjs`, import.meta.url));

function parseArgs(args) {
  if (args.length === 5 && args[0] === "decision_subject_hash" && args[1] === "--ticket" && args[2] && args[3] === "--decision" && args[4]) return { gateId: args[0], ticketId: args[2], decisionId: args[4] };
  if (args.length !== 3 || ![SYSTEM_TARGET_GATE_ID, DECISION_EVIDENCE_GATE_ID, DECISION_REVIEW_GATE_ID].includes(args[0]) || args[1] !== "--ticket" || !args[2]) {
    throw new TypeError(`Usage: node .codex/scripts/harness-decision-gate.mjs <${[SYSTEM_TARGET_GATE_ID, DECISION_EVIDENCE_GATE_ID, DECISION_REVIEW_GATE_ID].join("|")}> --ticket <ticket-id> | decision_subject_hash --ticket <ticket-id> --decision <decision-id>`);
  }
  return { gateId: args[0], ticketId: args[2] };
}

try {
  const { gateId, ticketId, decisionId } = parseArgs(process.argv.slice(2));
  if (gateId === "decision_subject_hash") {
    const decision = await readArchitectureDecisionForHash({ root: process.cwd(), ticketId, decisionId });
    process.stdout.write(`${JSON.stringify({ decision_id: decisionId, algorithm: "sha256", subject_hash: computeApprovalHash(decision) })}\n`);
  } else {
    const evaluator = new Map([
      [SYSTEM_TARGET_GATE_ID, evaluateSystemTargetsComplete],
      [DECISION_EVIDENCE_GATE_ID, evaluateDecisionEvidenceComplete],
      [DECISION_REVIEW_GATE_ID, evaluateDecisionReviewComplete],
    ]).get(gateId);
    const result = await evaluator({ root: process.cwd(), ticketId });
    if (result.rule_id !== gateId) throw new TypeError(`Unsupported decision gate: ${gateId}`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.status === "pass" ? 0 : result.status === "blocked" ? 2 : 1;
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 64;
}
