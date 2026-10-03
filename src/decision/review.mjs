import { verifyApproval } from "./approval.mjs";
import { REVIEW_CHECKLIST_ITEMS, validateArchitectureDecision, validateReviewRecord } from "./validation.mjs";

function gate(status, ruleId, reason, evidencePath, violations = []) {
  return { status, rule_id: ruleId, reason, evidence_path: evidencePath, violations };
}

export function evaluateDecisionGate(decision, targets, review, refs = {}) {
  const targetIds = [...(targets?.initial ?? []), ...(targets?.expected_growth ?? []), ...(targets?.architecture_boundary ?? [])].map((target) => target.id);
  const evidencePath = decision?.id ? `docs/specs/architecture-decisions/${decision.id}.yaml` : "docs/specs/architecture-decisions/";
  const errors = validateArchitectureDecision(decision, { targetIds, ...refs }).errors;
  if (errors.length) {
    return {
      decision_evidence_complete: gate("fail", "decision_evidence_complete", "Architecture Decision structure or references are invalid.", evidencePath, errors),
      decision_review_complete: gate("blocked", "decision_review_complete", "Review cannot pass before its decision is valid.", evidencePath),
    };
  }
  if (decision.status !== "accepted") {
    const waiting = gate("blocked", "decision_evidence_complete", `Decision ${decision.id} is not accepted.`, evidencePath);
    return { decision_evidence_complete: waiting, decision_review_complete: gate("blocked", "decision_review_complete", "Decision must be accepted before review can pass.", evidencePath) };
  }
  const approval = verifyApproval(decision, decision.approval);
  if (!approval.valid) {
    const invalid = gate("fail", "decision_evidence_complete", `Decision ${decision.id} approval is invalid.`, evidencePath, approval.errors);
    return { decision_evidence_complete: invalid, decision_review_complete: gate("blocked", "decision_review_complete", "Decision approval is invalid.", evidencePath) };
  }

  const evidence = gate("pass", "decision_evidence_complete", "Architecture Decision and its own approval are valid.", evidencePath);
  const reviewPath = decision.review_id ? `docs/specs/architecture-reviews/${decision.review_id}.yaml` : "docs/specs/architecture-reviews/";
  if (!review) return { decision_evidence_complete: evidence, decision_review_complete: gate("blocked", "decision_review_complete", "Decision ReviewRecord is missing.", reviewPath) };
  const reviewValidation = validateReviewRecord(review, { decisionIds: [decision.id], targetIds, ...refs });
  if (!reviewValidation.valid) return { decision_evidence_complete: evidence, decision_review_complete: gate("fail", "decision_review_complete", "Decision ReviewRecord is invalid.", reviewPath, reviewValidation.errors) };
  if (review.id !== decision.review_id || review.decision_id !== decision.id) return { decision_evidence_complete: evidence, decision_review_complete: gate("fail", "decision_review_complete", "ReviewRecord does not match the decision reference.", reviewPath) };
  if (review.outcome !== "ACCEPTED" || REVIEW_CHECKLIST_ITEMS.some((item) => review.checklist[item] !== true) || review.objections.some((objection) => objection.status === "open")) {
    return { decision_evidence_complete: evidence, decision_review_complete: gate("blocked", "decision_review_complete", "Review outcome, checklist, or objection state is unresolved.", reviewPath) };
  }
  return { decision_evidence_complete: evidence, decision_review_complete: gate("pass", "decision_review_complete", "ReviewRecord is accepted with all seven checklist items and no open objections.", reviewPath) };
}
