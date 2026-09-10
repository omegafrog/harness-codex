const REPAIRABLE_KINDS = new Set([
  "implementation_defect",
  "test_defect",
  "in_scope_spec_mismatch",
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
  if (!input || typeof input !== "object" || typeof input.fixed_point !== "string" || !input.fixed_point
    || input.implementation_commit_sha !== implementationCommitSha
    || typeof input.diff !== "string" || !input.diff.trim()
    || !Array.isArray(input.commit_list) || !input.commit_list.includes(input.fixed_point) || !input.commit_list.includes(implementationCommitSha)) return false;
  if (expected && (input.fixed_point !== expected.fixed_point || input.product_spec_path !== expected.product_spec_path || input.architecture_spec_path !== expected.architecture_spec_path)) return false;
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
      if (REPAIRABLE_KINDS.has(finding.kind) && finding.repairable !== false && (finding.kind !== "in_scope_spec_mismatch" || finding.in_scope === true)) repairable.push(finding);
      else if (finding.kind === "in_scope_spec_mismatch" && finding.in_scope !== true) blockers.push({ ...finding, kind: "in_scope_required" });
      else if (BLOCKER_KINDS.has(finding.kind) || finding.kind === "unclassified_review_finding" || finding.repairable === false || finding.in_scope === false) blockers.push(finding);
      else blockers.push({ ...finding, kind: "unclassified_review_finding", original_kind: finding.kind });
    });
  }
  return { repairable, blockers, has_findings: repairable.length > 0 || blockers.length > 0 };
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

export async function runBoundedReviewRepair({ plan = null, initialImplementation, initialReviews = [], reviewInput = null, maxRounds = 1, dispatchRepair = null, runReviewers = null } = {}) {
  if (!initialImplementation?.commit_sha) throw new TypeError("initialImplementation.commit_sha is required");
  const expectedReviewInput = reviewInput || initialReviews.find((review) => review?.review_input)?.review_input || null;
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
    if (!validFreshReviews(nextReviews, repaired, nextReviewInput)) return {
      state: "blocked",
      reason: "reviewer_isolation_violation",
      rounds: round,
      implementation: repaired,
      reviews: Array.isArray(nextReviews) ? nextReviews : [],
      history,
      blocker: { kind: "reviewer_isolation_violation", summary: "repair must be followed by independent fresh reviewers for the new commit" },
    };
    implementation = repaired;
    reviews = nextReviews;
    round = decision.round;
  }
}

export { BLOCKER_KINDS, REPAIRABLE_KINDS };
