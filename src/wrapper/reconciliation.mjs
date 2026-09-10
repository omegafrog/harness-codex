const REQUIRED_REVIEW_ROLES = ["spec", "standards"];
const STATUS_ALIASES = new Map([
  ["planned", "planned"],
  ["Planned", "planned"],
  ["in-progress", "in-progress"],
  ["In Progress", "in-progress"],
  ["completed", "completed"],
  ["Done", "completed"],
  ["done", "completed"],
  ["blocked", "blocked"],
  ["Blocked", "blocked"],
]);
const TERMINAL_STATUSES = new Set(["completed"]);
const TRACKER_MODES = new Set(["github", "local-markdown"]);

function expectedDoneStatus(trackerMode) {
  return trackerMode === "local-markdown" ? "completed" : "Done";
}

function trackerIsReconciled(snapshot, trackerMode) {
  if (!snapshot) return false;
  if (trackerMode === "local-markdown") return snapshot.status === "completed";
  const expected = expectedDoneStatus(trackerMode);
  return snapshot.status === expected
    && snapshot.project_status === expected
    && snapshot.all_issues_closed === true;
}

function canonicalStatus(status) {
  return STATUS_ALIASES.get(status) || status;
}

function unresolvedReviewRoles(reviews, implementation) {
  const byRole = new Map((reviews || []).map((review) => [review.role, review]));
  const unresolved = REQUIRED_REVIEW_ROLES
    .filter((role) => {
      const review = byRole.get(role);
      return review?.state !== "passed"
        || review.independent !== true
        || review.fresh_context !== true
        || typeof review.context_id !== "string"
        || !review.context_id
        || review.implementation_commit_sha !== implementation?.commit_sha;
    })
    .map((role) => `review:${role}`);
  const contextIds = REQUIRED_REVIEW_ROLES.map((role) => byRole.get(role)?.context_id).filter(Boolean);
  if (contextIds.length === REQUIRED_REVIEW_ROLES.length && new Set(contextIds).size !== contextIds.length) unresolved.push("review:independent-context");
  return unresolved;
}

function testsPassed(tests) {
  return tests?.status === "passed" || tests?.state === "passed" || tests?.passed === true;
}

function outcomePassed(evidence) {
  if (evidence === true || evidence?.status === "passed" || evidence?.state === "passed" || evidence?.passed === true) return true;
  return false;
}

function outcomeEvidenceFor(id, evidence) {
  if (Array.isArray(evidence)) return evidence.find((item) => item?.id === id || item?.outcome_id === id) || null;
  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) return evidence[id] ?? null;
  return null;
}

function unresolvedRequiredOutcomes(requiredOutcomes, evidence) {
  if (!Array.isArray(requiredOutcomes)) return ["required_outcome:invalid"];
  return requiredOutcomes
    .filter((id) => typeof id !== "string" || !outcomePassed(outcomeEvidenceFor(id, evidence)))
    .map((id) => `required_outcome:${typeof id === "string" ? id : "invalid"}`);
}

function unresolvedEvidence(evidence, implementation, tests, reviews, pr) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return ["evidence:missing"];
  const unresolved = [];
  for (const field of ["fixed_point", "implementation", "tests", "reviews", "pr"]) {
    if (evidence[field] === undefined || evidence[field] === null) unresolved.push(`evidence:${field}`);
  }
  if (evidence.implementation?.commit_sha !== implementation?.commit_sha) unresolved.push("evidence:implementation-mismatch");
  if (!testsPassed(evidence.tests) || !testsPassed(tests)) unresolved.push("evidence:tests-not-passed");
  if (!Array.isArray(evidence.reviews) || evidence.reviews.length !== reviews.length) unresolved.push("evidence:reviews-mismatch");
  if (evidence.pr?.merged !== pr?.merged) unresolved.push("evidence:pr-mismatch");
  return unresolved;
}

export function evaluateCompletion({
  implementation,
  reviews = [],
  tests = null,
  requiredOutcomes = [],
  requiredOutcomeEvidence = null,
  evidence = null,
  blocker = null,
  pr = {},
} = {}) {
  const unresolved = [];
  if (implementation?.state !== "completed" || !implementation.commit_sha) unresolved.push("implementation:incomplete");
  if (!testsPassed(tests)) unresolved.push("tests:not-passed");
  unresolved.push(...unresolvedRequiredOutcomes(requiredOutcomes, requiredOutcomeEvidence));
  unresolved.push(...unresolvedReviewRoles(reviews, implementation));
  unresolved.push(...unresolvedEvidence(evidence, implementation, tests, reviews, pr));
  if (!pr.merged) unresolved.push("pr:not-merged");
  if (blocker) unresolved.push(`blocker:${blocker.kind || "unknown"}`);
  return {
    can_complete: unresolved.length === 0,
    state: unresolved.length === 0 ? "completed" : blocker ? "blocked" : "in-progress",
    unresolved,
    evidence: {
      implementation_commit: implementation?.commit_sha || null,
      reviews: reviews.map(({ role, state }) => ({ role, state })),
      pr_merged: pr.merged === true,
    },
  };
}

export function recalculateDependents(plans, { completedPlanIds = [] } = {}) {
  if (!Array.isArray(plans)) throw new TypeError("plans must be an array");
  const completed = new Set(completedPlanIds);
  for (const plan of plans) if (TERMINAL_STATUSES.has(canonicalStatus(plan.status))) completed.add(plan.id);
  const ready = [];
  const waiting = [];
  for (const plan of plans) {
    const status = canonicalStatus(plan.status);
    if (TERMINAL_STATUSES.has(status) || completed.has(plan.id)) continue;
    const reasons = (plan.dependencies || []).filter((dependency) => !completed.has(dependency)).map((dependency) => `dependency:${dependency}`);
    if (status === "blocked") reasons.push("status:blocked");
    if (!reasons.length && ["planned", "in-progress", undefined].includes(status)) ready.push(plan.id);
    else waiting.push({ plan_id: plan.id, reasons: reasons.length ? reasons : [`status:${status}`] });
  }
  return { ready, waiting };
}

export function reconcileCompletion({
  plan,
  implementation,
  reviews = [],
  tests = null,
  requiredOutcomes = plan?.required_outcomes || [],
  requiredOutcomeEvidence = null,
  evidence = null,
  blocker = null,
  pr = {},
  trackerSnapshot = null,
  trackerMode = "github",
  dependents = [],
} = {}) {
  if (!plan?.id) throw new TypeError("plan.id is required");
  if (!TRACKER_MODES.has(trackerMode)) throw new TypeError(`Unsupported tracker mode: ${trackerMode}`);
  const completion = evaluateCompletion({ implementation, reviews, tests, requiredOutcomes, requiredOutcomeEvidence, evidence, blocker, pr });
  if (completion.can_complete && !trackerIsReconciled(trackerSnapshot, trackerMode)) {
    completion.can_complete = false;
    completion.state = "in-progress";
    completion.unresolved.push("tracker:not-reconciled");
  }
  const currentStatus = trackerSnapshot?.status || null;
  const requestedStatus = completion.can_complete ? expectedDoneStatus(trackerMode) : completion.state === "blocked" ? (trackerMode === "local-markdown" ? "blocked" : "Blocked") : (trackerMode === "local-markdown" ? "in-progress" : "In Progress");
  return {
    plan_id: plan.id,
    state: completion.state,
    can_complete: completion.can_complete,
    unresolved: completion.unresolved,
    completion,
    tracker_reconciliation: {
      mode: trackerMode,
      current_status: currentStatus,
      requested_status: requestedStatus,
      mutated: false,
      reason: "wrapper computes reconciliation; selected tracker remains the source of truth",
    },
    dependents: recalculateDependents(dependents, { completedPlanIds: completion.can_complete ? [plan.id] : [] }),
  };
}
