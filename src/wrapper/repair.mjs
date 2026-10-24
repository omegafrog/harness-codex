import { updateReviewAttempt } from '../workflow/review-attempts.mjs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPAIRABLE_KINDS = new Set([
  "implementation_defect",
  "test_defect",
  "in_scope_spec_mismatch",
  "verification_gap",
]);

const BLOCKER_KINDS = new Set([
  "requirement_ambiguity",
  "architecture_decision",
  "scope_expansion",
  "spec_conflict",
]);

const KIND_ALIASES = new Map([
  ["implementation", "implementation_defect"],
  ["implementation_error", "implementation_defect"],
  ["test", "test_defect"],
  ["test_failure", "test_defect"],
  ["spec_mismatch", "in_scope_spec_mismatch"],
  ["in_scope_spec_mismatch", "in_scope_spec_mismatch"],
  ["ambiguity", "requirement_ambiguity"],
  ["architecture", "architecture_decision"],
  ["scope", "scope_expansion"],
  ["conflict", "spec_conflict"],
]);

function findingList(review) {
  const report = review?.report && typeof review.report === "object" ? review.report : review;
  return Array.isArray(report?.findings) ? report.findings : [];
}

function findingKind(finding) {
  const raw = finding?.kind || finding?.category || finding?.type;
  return typeof raw === "string" ? KIND_ALIASES.get(raw) || raw : null;
}

function normalizeFinding(finding, review, index) {
  const kind = findingKind(finding);
  return {
    ...finding,
    kind: kind || "unclassified_review_finding",
    reviewer_role: review?.role || null,
    finding_index: index,
  };
}

function validReviewInput(input, implementationCommitSha, expected = null) {
  if (!input || typeof input !== "object" || typeof input.repository !== "string" || !input.repository
    || typeof input.fixed_point !== "string" || !input.fixed_point
    || input.implementation_commit_sha !== implementationCommitSha
    || typeof input.diff !== "string" || !input.diff.trim()
    || !Array.isArray(input.commit_list) || !input.commit_list.includes(input.fixed_point) || !input.commit_list.includes(implementationCommitSha)
    || !input.diff_range || input.diff_range.from !== input.fixed_point || input.diff_range.to !== implementationCommitSha
    || typeof input.product_spec_path !== "string" || !input.product_spec_path
    || typeof input.architecture_spec_path !== "string" || !input.architecture_spec_path) return false;
  if (expected && (input.repository !== expected.repository
    || input.fixed_point !== expected.fixed_point
    || input.implementation_commit_sha !== expected.implementation_commit_sha
    || input.product_spec_path !== expected.product_spec_path
    || input.architecture_spec_path !== expected.architecture_spec_path
    || input.diff !== expected.diff
    || JSON.stringify(input.commit_list) !== JSON.stringify(expected.commit_list)
    || JSON.stringify(input.diff_range) !== JSON.stringify(expected.diff_range))) return false;
  return true;
}

function validReviewProvenance(reviews, implementationCommitSha = null, expectedReviewInput = null) {
  if (!Array.isArray(reviews) || reviews.length !== 2) return false;
  const roles = new Set(reviews.map((review) => review?.role));
  if (roles.size !== 2 || !roles.has("standards") || !roles.has("spec")) return false;
  return reviews.every((review) => review?.independent === true
    && review?.fresh_context === true
    && typeof review.context_id === "string"
    && review.context_id.length > 0
    && typeof review.implementation_commit_sha === "string"
    && review.implementation_commit_sha.length > 0
    && (implementationCommitSha === null || review.implementation_commit_sha === implementationCommitSha)
    && new Set(reviews.map((review) => review.context_id)).size === reviews.length
    && (!expectedReviewInput || validReviewInput(review.review_input, implementationCommitSha, expectedReviewInput)));
}

export function classifyReviewFindings(reviews = []) {
  if (!Array.isArray(reviews)) throw new TypeError("reviews must be an array");
  const repairable = [];
  const blockers = [];
  const deferred = [];
  const advisory = [];
  if (!validReviewProvenance(reviews)) blockers.push({ kind: "reviewer_isolation_violation", summary: "both reviewers must provide independent fresh-context provenance for one implementation commit" });
  for (const review of reviews) {
    const findings = findingList(review);
    if (review?.state === "error" || review?.state === "unknown") {
      blockers.push({ kind: "review_unavailable", reviewer_role: review.role || null, summary: review.error?.message || "review result is unavailable" });
      continue;
    }
    if (review?.state !== "passed" && findings.length === 0) {
      blockers.push({ kind: "unclassified_review_finding", reviewer_role: review?.role || null, summary: "non-passing review has no structured finding" });
      continue;
    }
    findings.forEach((rawFinding, index) => {
      const finding = normalizeFinding(rawFinding, review, index);
      const hasEvidence = typeof finding.evidence === 'string' && finding.evidence.trim();
      if (finding.kind === 'contract_sync' && finding.disposition === 'integration_deferred' && finding.severity === 'minor' && finding.completion_kind === 'feature_implemented' && hasEvidence) deferred.push(finding);
      else if (finding.kind === 'advisory' && finding.severity === 'minor' && finding.blocking === false && hasEvidence) advisory.push(finding);
      else if (REPAIRABLE_KINDS.has(finding.kind) && finding.repairable !== false && (finding.kind !== "in_scope_spec_mismatch" || finding.in_scope === true)) repairable.push(finding);
      else if (finding.kind === "in_scope_spec_mismatch" && finding.in_scope !== true) blockers.push({ ...finding, kind: "in_scope_required" });
      else if (BLOCKER_KINDS.has(finding.kind) || finding.kind === "unclassified_review_finding" || finding.repairable === false || finding.in_scope === false) blockers.push(finding);
      else blockers.push({ ...finding, kind: "unclassified_review_finding", original_kind: finding.kind });
    });
  }
  return { repairable, blockers, deferred, advisory, has_findings: repairable.length > 0 || blockers.length > 0 };
}

export async function reserveImplementationRepair({ root, planId, reviewInput, reviews, maxRounds = 1, resolution }) {
  // Anchor the budget to the primary checkout so recreating a worktree cannot reset it.
  const primary = execFileSync('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root, encoding: 'utf8' }).split('\0')[0];
  if (!primary.startsWith('worktree ')) throw new Error('Cannot resolve the primary review workspace');
  const scope = { root: primary.slice(9), scope: `implementation-${planId}` };
  if (resolution !== undefined) return updateReviewAttempt({ ...scope, action: 'resolve-repair', reason: resolution });
  if (resolve(reviewInput?.repository || '') !== resolve(root)) throw new TypeError('Review input must belong to the active implementation workspace');
  if (!validReviewInput(reviewInput, reviewInput?.implementation_commit_sha) || !validReviewProvenance(reviews, reviewInput.implementation_commit_sha, reviewInput)) throw new TypeError('Repair requires both fresh reviewers for the fixed-point input');
  const decision = planRepairRound({ reviews, maxRounds });
  if (decision.action !== 'repair') return decision;
  return updateReviewAttempt({ ...scope, action: 'repair', inputs: { ...reviewInput, reviewer_ids: reviews.map((item) => item.context_id) }, maxRounds, findings: decision.classification.repairable });
}

export function planRepairRound({ reviews = [], round = 0, maxRounds = 1 } = {}) {
  if (!Number.isInteger(round) || round < 0) throw new TypeError("round must be a non-negative integer");
  if (!Number.isInteger(maxRounds) || maxRounds < 0) throw new TypeError("maxRounds must be a non-negative integer");
  const classification = classifyReviewFindings(reviews);
  if (!classification.has_findings) return { action: "complete", state: "passed", round, classification };
  if (classification.blockers.length > 0) return {
    action: "block",
    state: "blocked",
    reason: classification.blockers[0].kind,
    round,
    classification,
  };
  if (round >= maxRounds) return {
    action: "block",
    state: "blocked",
    reason: "max_repair_rounds_exceeded",
    round,
    classification,
  };
  return {
    action: "repair",
    state: "repair-required",
    round: round + 1,
    classification,
    repair: {
      fresh_context: true,
      empty_context: true,
      same_plan: true,
      repair_round: round + 1,
      findings: classification.repairable,
    },
  };
}

function validRepairImplementation(implementation, previous, plan) {
  return implementation
    && typeof implementation === "object"
    && implementation.commit_sha
    && implementation.commit_sha !== previous.commit_sha
    && typeof plan?.id === "string"
    && implementation.plan_id === plan.id
    && typeof implementation.diff === "string"
    && implementation.diff.trim().length > 0
    && Array.isArray(implementation.commit_list)
    && implementation.commit_list.includes(previous.commit_sha)
    && implementation.commit_list.includes(implementation.commit_sha)
    && implementation.fresh_context === true
    && implementation.empty_context === true;
}

function validFreshReviews(reviews, implementation, expectedReviewInput = null) {
  const requiredRoles = new Set(["standards", "spec"]);
  const roles = new Set((reviews || []).map((review) => review?.role));
  return Array.isArray(reviews)
    && roles.size === requiredRoles.size
    && [...requiredRoles].every((role) => roles.has(role))
    && reviews.every((review) => review?.independent === true && review?.fresh_context === true && review?.context_id && review.implementation_commit_sha === implementation.commit_sha)
    && new Set(reviews.map((review) => review.context_id)).size === reviews.length
    && (!expectedReviewInput || validReviewProvenance(reviews, implementation.commit_sha, expectedReviewInput));
}

export async function runBoundedReviewRepair({ plan = null, initialImplementation, initialReviews = [], reviewInput = null, maxRounds = 1, dispatchRepair = null, runReviewers = null, reserveRepair = null } = {}) {
  if (!initialImplementation?.commit_sha) throw new TypeError("initialImplementation.commit_sha is required");
  const expectedReviewInput = reviewInput || initialReviews.find((review) => review?.review_input)?.review_input || null;
  if (!expectedReviewInput || !validReviewInput(expectedReviewInput, initialImplementation.commit_sha)) return {
    state: "blocked",
    reason: "review_input_invalid",
    rounds: 0,
    implementation: initialImplementation,
    reviews: initialReviews,
    history: [],
    blocker: { kind: "review_input_invalid", summary: "bounded repair requires the complete fixed-point review input" },
  };
  if (!validReviewProvenance(initialReviews, initialImplementation.commit_sha, expectedReviewInput)) return {
    state: "blocked",
    reason: "reviewer_isolation_violation",
    rounds: 0,
    implementation: initialImplementation,
    reviews: initialReviews,
    history: [],
    blocker: { kind: "reviewer_isolation_violation", summary: "both reviewers must provide independent fresh-context provenance for the initial implementation commit" },
  };
  let implementation = initialImplementation;
  let reviews = initialReviews;
  const reviewContexts = new Set(initialReviews.map((item) => item.context_id));
  let round = 0;
  const history = [];
  while (true) {
    const decision = planRepairRound({ reviews, round, maxRounds });
    history.push(decision);
    if (decision.action === "complete") return { state: "passed", reason: null, rounds: round, implementation, reviews, history };
    if (decision.action === "block") return { state: "blocked", reason: decision.reason, rounds: round, implementation, reviews, history, blocker: decision.classification.blockers[0] || null };
    if (typeof dispatchRepair !== "function" || typeof runReviewers !== "function") return {
      state: "blocked",
      reason: "repair_adapter_unavailable",
      rounds: round,
      implementation,
      reviews,
      history,
      blocker: { kind: "repair_adapter_unavailable", summary: "bounded repair requires injected repair and reviewer adapters" },
    };
    let repaired;
    if (reserveRepair) {
      try {
        const reservation = await reserveRepair({ reviewInput: reviews[0].review_input, reviews, maxRounds });
        if (reservation.status !== 'pass') throw new Error(reservation.reason || 'Repair reservation failed');
        decision.round = reservation.round;
        round = reservation.round;
      } catch (error) {
        return { state: 'blocked', reason: error.code || 'repair_admission_failed', rounds: error.rounds ?? round, implementation, reviews, history, blocker: { kind: 'review-repair-admission', summary: error.message } };
      }
    }
    try {
      repaired = await dispatchRepair({
        plan,
        implementation,
        findings: decision.classification.repairable,
        repair_round: decision.round,
        fresh_context: true,
        empty_context: true,
        same_plan: true,
      });
    } catch (error) {
      return { state: "blocked", reason: "repair_execution_failed", rounds: round, implementation, reviews, history, blocker: { kind: "repair_execution_failed", summary: error.message } };
    }
    if (!validRepairImplementation(repaired, implementation, plan)) return {
      state: "blocked",
      reason: "invalid_repair_result",
      rounds: round,
      implementation,
      reviews,
      history,
      blocker: { kind: "invalid_repair_result", summary: "repair must return a new commit from a fresh empty context for the same plan" },
    };
    const nextReviewInput = expectedReviewInput ? {
      ...expectedReviewInput,
      implementation_commit_sha: repaired.commit_sha,
      commit_list: repaired.commit_list,
      diff: repaired.diff,
      diff_range: { from: expectedReviewInput.fixed_point, to: repaired.commit_sha },
    } : null;
    let nextReviews;
    try {
      nextReviews = await runReviewers({
        plan,
        implementation: repaired,
        previous_implementation: implementation,
        repair_round: decision.round,
        fresh_context: true,
        empty_context: true,
        review_input: nextReviewInput,
      });
    } catch (error) {
      return { state: "blocked", reason: "repair_review_failed", rounds: round, implementation: repaired, reviews, history, blocker: { kind: "repair_review_failed", summary: error.message } };
    }
    if (!validFreshReviews(nextReviews, repaired, nextReviewInput) || nextReviews.some((item) => reviewContexts.has(item.context_id))) return {
      state: "blocked",
      reason: "reviewer_isolation_violation",
      rounds: round,
      implementation: repaired,
      reviews: Array.isArray(nextReviews) ? nextReviews : [],
      history,
      blocker: { kind: "reviewer_isolation_violation", summary: "repair must be followed by independent fresh reviewers for the new commit" },
    };
    implementation = repaired;
    nextReviews.forEach((item) => reviewContexts.add(item.context_id));
    reviews = nextReviews;
    round = decision.round;
  }
}

export { BLOCKER_KINDS, REPAIRABLE_KINDS };
