import { readArchitectureDecision, readReviewRecord, readSystemTargets } from "../decision/artifacts.mjs";
import { evaluateDecisionGate } from "../decision/review.mjs";

export const SYSTEM_TARGET_GATE_ID = "system_targets_complete";
export const DECISION_EVIDENCE_GATE_ID = "decision_evidence_complete";
export const DECISION_REVIEW_GATE_ID = "decision_review_complete";
const SAFE_TICKET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function evaluateSystemTargetsComplete({ root = process.cwd(), ticketId }) {
  const safeTicketId = typeof ticketId === "string" && SAFE_TICKET_ID.test(ticketId) ? ticketId : "<invalid-ticket-id>";
  const evidencePath = `docs/specs/${safeTicketId}/system-targets.yaml`;
  try {
    await readSystemTargets({ root, ticketId });
    return {
      status: "pass",
      rule_id: SYSTEM_TARGET_GATE_ID,
      reason: "System Targets are structurally complete.",
      evidence_path: evidencePath,
      violations: [],
    };
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return {
      status: missing ? "blocked" : "fail",
      rule_id: SYSTEM_TARGET_GATE_ID,
      reason: missing ? "System Targets artifact is missing." : "System Targets could not be validated.",
      evidence_path: evidencePath,
      violations: error?.validation?.errors ?? [{ code: missing ? "missing_artifact" : "invalid_artifact", path: evidencePath, message: error.message }],
    };
  }
}

function result(status, ruleId, reason, evidencePath, violations = []) {
  return { status, rule_id: ruleId, reason, evidence_path: evidencePath, violations };
}

async function loadDecisionContext(root, ticketId) {
  const targets = await readSystemTargets({ root, ticketId });
  if (targets.decision_metadata?.decision_layer_version !== 1) return { targets, legacy: true };
  const targetIds = [...targets.initial, ...targets.expected_growth, ...targets.architecture_boundary].map((target) => target.id);
  return { targets, legacy: false, decisionIds: targets.decision_metadata.decision_ids, targetIds };
}

export async function evaluateDecisionEvidenceComplete({ root = process.cwd(), ticketId }) {
  const safeTicketId = typeof ticketId === "string" && SAFE_TICKET_ID.test(ticketId) ? ticketId : "<invalid-ticket-id>";
  const evidencePath = `docs/specs/${safeTicketId}/architecture-decisions/`;
  try {
    const context = await loadDecisionContext(root, ticketId);
    if (context.legacy) return result("pass", DECISION_EVIDENCE_GATE_ID, "Legacy ticket has no decision-layer opt-in marker.", `docs/specs/${safeTicketId}/system-targets.yaml`);
    for (const id of context.decisionIds) {
      const decision = await readArchitectureDecision({ root, ticketId, decisionId: id, refs: { targetIds: context.targetIds } });
      const gates = evaluateDecisionGate(decision, context.targets);
      if (gates.decision_evidence_complete.status !== "pass") return gates.decision_evidence_complete;
    }
    return result("pass", DECISION_EVIDENCE_GATE_ID, "Opt-in architecture decisions and their own approvals are valid.", evidencePath);
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return result(missing ? "blocked" : "fail", DECISION_EVIDENCE_GATE_ID, missing ? "An opted-in decision artifact is missing." : "An architecture decision is invalid.", evidencePath, error?.validation?.errors ?? [{ code: missing ? "missing_artifact" : "invalid_artifact", path: evidencePath, message: error.message }]);
  }
}

export async function evaluateDecisionReviewComplete({ root = process.cwd(), ticketId }) {
  const safeTicketId = typeof ticketId === "string" && SAFE_TICKET_ID.test(ticketId) ? ticketId : "<invalid-ticket-id>";
  const evidencePath = `docs/specs/${safeTicketId}/architecture-reviews/`;
  try {
    const context = await loadDecisionContext(root, ticketId);
    if (context.legacy) return result("pass", DECISION_REVIEW_GATE_ID, "Legacy ticket has no decision-layer opt-in marker.", `docs/specs/${safeTicketId}/system-targets.yaml`);
    for (const id of context.decisionIds) {
      const decision = await readArchitectureDecision({ root, ticketId, decisionId: id, refs: { targetIds: context.targetIds } });
      if (typeof decision.review_id !== "string") return result("blocked", DECISION_REVIEW_GATE_ID, `Decision ${id} has no review record reference.`, evidencePath);
      const review = await readReviewRecord({ root, ticketId, reviewId: decision.review_id, refs: { decisionIds: context.decisionIds } });
      const gates = evaluateDecisionGate(decision, context.targets, review);
      if (gates.decision_review_complete.status !== "pass") return gates.decision_review_complete;
    }
    return result("pass", DECISION_REVIEW_GATE_ID, "All opted-in decisions have accepted reviews with the complete checklist.", evidencePath);
  } catch (error) {
    const missing = error?.code === "ENOENT";
    return result(missing ? "blocked" : "fail", DECISION_REVIEW_GATE_ID, missing ? "An opted-in review artifact is missing." : "A review record is invalid.", evidencePath, error?.validation?.errors ?? [{ code: missing ? "missing_artifact" : "invalid_artifact", path: evidencePath, message: error.message }]);
  }
}

const REGISTERED_STAGE_GATES = new Map([
  [SYSTEM_TARGET_GATE_ID, evaluateSystemTargetsComplete],
  [DECISION_EVIDENCE_GATE_ID, evaluateDecisionEvidenceComplete],
  [DECISION_REVIEW_GATE_ID, evaluateDecisionReviewComplete],
]);

export async function evaluateStageGates({ workflow, stageId, root = process.cwd(), ticketId }) {
  const stage = workflow?.stages?.find((candidate) => candidate.id === stageId);
  if (!stage) throw new TypeError(`Unknown workflow stage: ${stageId}`);
  const results = [];
  for (const ruleId of stage.gates ?? []) {
    const evaluator = REGISTERED_STAGE_GATES.get(ruleId);
    if (!evaluator) throw new TypeError(`No stage gate evaluator is registered for: ${ruleId}`);
    results.push(await evaluator({ root, ticketId }));
  }
  return results;
}
