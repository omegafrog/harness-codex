#!/usr/bin/env node
const installedRuntime = new URL("../../.harness/src/workflow/stage-gates.mjs", import.meta.url);
const decisionRuntime = new URL("../../.harness/src/decision/", import.meta.url);
const { ARCHITECTURE_DIAGRAM_COMPLETION_GATE_ID, DECISION_EVIDENCE_GATE_ID, DECISION_REVIEW_GATE_ID, evaluateArchitectureDiagramCompletion, evaluateDecisionEvidenceComplete, evaluateDecisionReviewComplete, evaluateProductDiagramCompletion, evaluateSystemTargetsComplete, PRODUCT_DIAGRAM_COMPLETION_GATE_ID, SYSTEM_TARGET_GATE_ID } = await import(installedRuntime.href);
const { approveArchitectureDecision } = await import(new URL('artifacts.mjs', decisionRuntime));

function parseArgs(args) {
  if (args.length === 7 && args[0] === "approve" && args[1] === "--ticket" && args[3] === "--decision" && args[5] === "--delegated" && args[6] === "true" && args[2] && args[4]) return { gateId: args[0], ticketId: args[2], decisionId: args[4], delegated: true };
  if (args.length === 9 && args[0] === "approve" && args[1] === "--ticket" && args[3] === "--decision" && args[5] === "--answers" && args[7] === "--question" && args[2] && args[4] && args[6] && args[8]) return { gateId: args[0], ticketId: args[2], decisionId: args[4], answersPath: args[6], questionId: args[8] };
  if (args.length !== 3 || ![SYSTEM_TARGET_GATE_ID, DECISION_EVIDENCE_GATE_ID, DECISION_REVIEW_GATE_ID, PRODUCT_DIAGRAM_COMPLETION_GATE_ID, ARCHITECTURE_DIAGRAM_COMPLETION_GATE_ID].includes(args[0]) || args[1] !== "--ticket" || !args[2]) {
    throw new TypeError(`Usage: node .codex/scripts/harness-decision-gate.mjs <${[SYSTEM_TARGET_GATE_ID, DECISION_EVIDENCE_GATE_ID, DECISION_REVIEW_GATE_ID, PRODUCT_DIAGRAM_COMPLETION_GATE_ID, ARCHITECTURE_DIAGRAM_COMPLETION_GATE_ID].join("|")}> --ticket <ticket-id> | approve --ticket <ticket-id> --decision <decision-id> --answers <session-relative-path> --question <question-id> | approve --ticket <ticket-id> --decision <decision-id> --delegated true`);
  }
  return { gateId: args[0], ticketId: args[2] };
}

try {
  const { gateId, ticketId, decisionId, answersPath, questionId, delegated } = parseArgs(process.argv.slice(2));
  if (gateId === "approve") {
    const approved = await approveArchitectureDecision({ root: process.cwd(), ticketId, decisionId, answersPath, questionId, delegated });
    process.stdout.write(`${JSON.stringify({ decision_id: approved.value.id, status: approved.value.status })}\n`);
  } else {
    const evaluator = new Map([
      [SYSTEM_TARGET_GATE_ID, evaluateSystemTargetsComplete],
      [DECISION_EVIDENCE_GATE_ID, evaluateDecisionEvidenceComplete],
      [DECISION_REVIEW_GATE_ID, evaluateDecisionReviewComplete],
      [PRODUCT_DIAGRAM_COMPLETION_GATE_ID, evaluateProductDiagramCompletion],
      [ARCHITECTURE_DIAGRAM_COMPLETION_GATE_ID, evaluateArchitectureDiagramCompletion],
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
